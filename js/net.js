// net.js — PeerJS による P2P ルーム（スター型・ホスト権威）
// ホスト: GameController を保持し、各ゲストに view を配信。ゲスト: 操作を送るだけ。
"use strict";
import { GameController } from "./game.js";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 紛らわしい文字を除外
const PROTOCOL_VERSION = 1;
const PING_INTERVAL_MS = 5000;

function randomCode(len = 5) {
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

const peerId = (code) => "lexio-webapp-" + code.toLowerCase();

function newPeer(id) {
  // vendor/peerjs.min.js がグローバル Peer を定義
  return id ? new Peer(id) : new Peer();
}

// ---------------------------------------------------------------------------
export class HostSession {
  /**
   * cb: {onReady(code), onLobby(seats), onState(view), onError(msg), onLog(msg)}
   */
  constructor(hostName, tableSize, rounds, cb) {
    this.hostName = hostName;
    this.tableSize = tableSize;
    this.rounds = rounds;
    this.cb = cb;
    this.code = randomCode();
    this.conns = new Map();     // seat -> DataConnection
    this.seatNames = new Map(); // seat -> name
    this.controller = null;
    this.inGame = false;
    this._openPeer();
  }

  _openPeer(retries = 3) {
    this.peer = newPeer(peerId(this.code));
    this.peer.on("open", () => this.cb.onReady(this.code));
    this.peer.on("error", (e) => {
      if (e.type === "unavailable-id" && retries > 0) {
        this.code = randomCode();
        this._openPeer(retries - 1);
      } else {
        this.cb.onError("接続サーバーに到達できません: " + e.type);
      }
    });
    this.peer.on("connection", (conn) => this._onConnection(conn));
  }

  _lobbySeats() {
    const seats = [{ seat: 0, name: this.hostName, kind: "human" }];
    for (let s = 1; s < this.tableSize; s++) {
      if (this.seatNames.has(s)) seats.push({ seat: s, name: this.seatNames.get(s), kind: "remote" });
      else seats.push({ seat: s, name: `空席`, kind: "open" });
    }
    return seats;
  }

  _broadcastLobby() {
    const msg = { t: "lobby", seats: this._lobbySeats() };
    for (const conn of this.conns.values()) conn.send(msg);
    this.cb.onLobby(this._lobbySeats());
  }

  _onConnection(conn) {
    conn.on("data", (m) => {
      if (!m || typeof m !== "object") return;
      if (m.t === "hello") {
        if (this.inGame) { conn.send({ t: "error", code: "in_progress" }); conn.close(); return; }
        if (m.protocolVersion !== PROTOCOL_VERSION) { conn.send({ t: "error", code: "version" }); conn.close(); return; }
        let seat = -1;
        for (let s = 1; s < this.tableSize; s++) {
          if (!this.seatNames.has(s)) { seat = s; break; }
        }
        if (seat < 0) { conn.send({ t: "error", code: "full" }); conn.close(); return; }
        this.conns.set(seat, conn);
        this.seatNames.set(seat, (m.name || "ゲスト").slice(0, 20));
        conn._seat = seat;
        conn.send({ t: "welcome", seat });
        this._broadcastLobby();
      } else if (m.t === "action" && this.controller && conn._seat !== undefined) {
        const seat = conn._seat;
        const err = m.kind === "pass"
          ? this.controller.pass(seat)
          : this.controller.play(seat, (m.tiles || []).map(Number));
        if (err) conn.send({ t: "reject", reason: err });
      } else if (m.t === "ping") {
        conn.send({ t: "pong" });
      }
    });
    const drop = () => this._onDisconnect(conn);
    conn.on("close", drop);
    conn.on("error", drop);
  }

  _onDisconnect(conn) {
    const seat = conn._seat;
    if (seat === undefined || this.conns.get(seat) !== conn) return;
    this.conns.delete(seat);
    if (this.inGame && this.controller && !this.controller.state.isTerminal()) {
      this.controller.takeOverByAI(seat);
    } else {
      this.seatNames.delete(seat);
      this._broadcastLobby();
    }
  }

  startGame() {
    const seats = [];
    for (let s = 0; s < this.tableSize; s++) {
      if (s === 0) seats.push({ kind: "human", name: this.hostName });
      else if (this.seatNames.has(s)) seats.push({ kind: "remote", name: this.seatNames.get(s) });
      else seats.push({ kind: "ai", name: `AI-${s}` });
    }
    this.inGame = true;
    this.controller = new GameController(this.tableSize, seats, this.rounds,
                                         () => this._pushStates());
    for (const [seat, conn] of this.conns) conn.send({ t: "start", yourSeat: seat });
    this._pushStates();
    this.controller.advance();
  }

  // 終局後: 残ラウンドがあれば次ラウンド、無ければ同設定で新しいマッチ
  advanceMatch() {
    if (!this.controller) return;
    if (!this.controller.nextRound()) this.rematch();
  }

  _pushStates() {
    if (!this.controller) return;
    for (const [seat, conn] of this.conns) {
      try { conn.send({ t: "state", view: this.controller.view(seat) }); } catch {}
    }
    this.cb.onState(this.controller.view(0));
  }

  // ホスト自身の操作
  play(tiles) { return this.controller ? this.controller.play(0, tiles) : "未開始"; }
  pass() { return this.controller ? this.controller.pass(0) : "未開始"; }

  rematch() {
    if (!this.inGame) return;
    const names = this.controller.seats;
    this.controller = new GameController(this.tableSize, names.map((s) => ({ ...s })),
                                         this.rounds, () => this._pushStates());
    for (const [seat, conn] of this.conns) conn.send({ t: "start", yourSeat: seat });
    this._pushStates();
    this.controller.advance();
  }

  destroy() {
    try { this.peer && this.peer.destroy(); } catch {}
    this.conns.clear();
  }
}

// ---------------------------------------------------------------------------
export class GuestSession {
  /**
   * cb: {onJoined(seat), onLobby(seats), onStart(), onState(view),
   *      onReject(reason), onError(msg), onHostLost()}
   */
  constructor(guestName, code, cb) {
    this.cb = cb;
    this.seat = -1;
    this.peer = newPeer();
    this.alive = false;
    this.peer.on("error", (e) => {
      if (e.type === "peer-unavailable") this.cb.onError("その部屋コードは見つかりません");
      else if (!this.alive) this.cb.onError("接続サーバーに到達できません: " + e.type);
    });
    this.peer.on("open", () => {
      this.conn = this.peer.connect(peerId(code), { reliable: true });
      this.conn.on("open", () => {
        this.alive = true;
        this.conn.send({ t: "hello", name: guestName, protocolVersion: PROTOCOL_VERSION });
        this._pingTimer = setInterval(() => {
          try { this.conn.send({ t: "ping" }); } catch {}
        }, PING_INTERVAL_MS);
      });
      this.conn.on("data", (m) => this._onData(m));
      const lost = () => {
        if (!this.alive) return;
        this.alive = false;
        clearInterval(this._pingTimer);
        this.cb.onHostLost();
      };
      this.conn.on("close", lost);
      this.conn.on("error", lost);
    });
  }

  _onData(m) {
    if (!m || typeof m !== "object") return;
    switch (m.t) {
      case "welcome": this.seat = m.seat; this.cb.onJoined(m.seat); break;
      case "error": {
        const msgs = { full: "満席です", in_progress: "対局中のため参加できません",
                       version: "バージョンが異なります（ページを更新してください）" };
        this.cb.onError(msgs[m.code] || m.code);
        break;
      }
      case "lobby": this.cb.onLobby(m.seats); break;
      case "start": this.cb.onStart(); break;
      case "state": this.cb.onState(m.view); break;
      case "reject": this.cb.onReject(m.reason); break;
      case "pong": break;
    }
  }

  play(tiles) { this.conn.send({ t: "action", kind: "play", tiles }); return null; }
  pass() { this.conn.send({ t: "action", kind: "pass" }); return null; }

  destroy() {
    clearInterval(this._pingTimer);
    this.alive = false;
    try { this.peer && this.peer.destroy(); } catch {}
  }
}
