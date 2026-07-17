// net.js — PeerJS による P2P ルーム（スター型・ホスト権威）
// リロード/切断は「待機式」: AI代打はせず、一時停止して席トークンでの復帰を待つ。
"use strict";
import { GameController } from "./game.js";
import { getIceServers } from "./netconfig.js";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 紛らわしい文字を除外
const PROTOCOL_VERSION = 2;
const PING_INTERVAL_MS = 5000;
const GUEST_RETRY_MS = 2500;
const GUEST_RETRY_MAX = 72;          // ≈3分
const CONNECT_TIMEOUT_MS = 15000;    // 初回接続の見切り
export const STORE_HOST = "lexio.host.v1";
export const STORE_GUEST = "lexio.guest.v1";

function randomCode(len = 5) {
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}
const randomToken = () =>
  Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join("");

const peerId = (code) => "lexio-webapp-" + code.toLowerCase();

export function newPeer(id) {
  // vendor/peerjs.min.js がグローバル Peer を定義。TURN/STUN は netconfig から。
  const opts = { config: { iceServers: getIceServers() } };
  return id ? new Peer(id, opts) : new Peer(opts);
}

// ---------------------------------------------------------------------------
export class HostSession {
  /**
   * cb: {onReady(code), onLobby(seats), onState(view), onError(msg)}
   * resume: sessionStorage から復元したデータ（リロード復帰時）
   */
  constructor(hostName, tableSize, rounds, cb, resume = null, opts = {}) {
    this.hostName = hostName;
    this.tableSize = tableSize;
    this.rounds = rounds;
    this.cb = cb;
    this.openSeats = Math.max(0, Math.min(tableSize - 1, opts.openSeats ?? tableSize - 1));
    this.conns = new Map();     // seat -> DataConnection
    this.seatNames = new Map(); // seat -> name
    this.seatTokens = new Map();// seat -> 復帰用トークン
    this.controller = null;
    this.inGame = false;
    this.proposal = null;       // 終了提案 {from, votes:{seat:true}}
    this.resuming = !!resume;
    if (resume) {
      this.code = resume.code;
      this.hostName = resume.hostName;
      this.tableSize = resume.tableSize;
      this.rounds = resume.rounds;
      this.openSeats = resume.openSeats ?? this.tableSize - 1;
      this.seatNames = new Map(resume.seatNames);
      this.seatTokens = new Map(resume.seatTokens);
      this.inGame = true;
      this.controller = GameController.restore(resume.snapshot, () => this._pushStates());
    } else {
      this.code = randomCode();
    }
    this._openPeer();
  }

  setName(name) {
    this.hostName = (name || "あなた").slice(0, 20);
    if (!this.inGame) this._broadcastLobby();
  }

  static loadResume() {
    try {
      const raw = sessionStorage.getItem(STORE_HOST);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d && d.snapshot && d.snapshot.v === 1 ? d : null;
    } catch { return null; }
  }

  _openPeer(retries = 3) {
    this.peer = newPeer(peerId(this.code));
    this.peer.on("open", () => {
      this.cb.onReady(this.code);
      if (!this.resuming) this._broadcastLobby();
      if (this.resuming) {
        this.controller._note("ホストが復帰しました", "info");
        this._updatePause();
        this._pushStates();
        this.controller.advance();
      }
    });
    this.peer.on("error", (e) => {
      if (e.type === "unavailable-id") {
        if (this.resuming) {
          // 旧IDの解放待ち（PeerServer側のTTL）
          if (retries > 0) setTimeout(() => this._openPeer(retries - 1), 3000);
          else this.cb.onError("部屋IDの再取得に失敗しました（時間をおいて再試行してください）");
        } else if (retries > 0) {
          this.code = randomCode();
          this._openPeer(retries - 1);
        } else {
          this.cb.onError("部屋コードの取得に失敗しました");
        }
      } else if (e.type !== "peer-unavailable") {
        this.cb.onError("接続サーバーに到達できません: " + e.type);
      }
    });
    this.peer.on("connection", (conn) => this._onConnection(conn));
  }

  names() { return this.controller ? this.controller.names() : []; }

  _lobbySeats() {
    const seats = [{ seat: 0, name: this.hostName, kind: "human" }];
    for (let s = 1; s < this.tableSize; s++) {
      if (this.seatNames.has(s)) seats.push({ seat: s, name: this.seatNames.get(s), kind: "remote" });
      else if (s <= this.openSeats) seats.push({ seat: s, name: "募集中", kind: "open" });
      else seats.push({ seat: s, name: "AI", kind: "ai" });
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
      if (m.t === "hello") this._onHello(conn, m);
      else if (m.t === "action" && this.controller && conn._seat !== undefined) {
        const seat = conn._seat;
        const err = m.kind === "pass"
          ? this.controller.pass(seat)
          : this.controller.play(seat, (m.tiles || []).map(Number));
        if (err) conn.send({ t: "reject", reason: err });
      } else if (m.t === "endPropose" && conn._seat !== undefined) {
        this.proposeEnd(conn._seat);
      } else if (m.t === "endVote" && conn._seat !== undefined) {
        this.vote(conn._seat, !!m.agree);
      } else if (m.t === "ping") {
        conn.send({ t: "pong" });
      }
    });
    const drop = () => this._onDisconnect(conn);
    conn.on("close", drop);
    conn.on("error", drop);
  }

  _onHello(conn, m) {
    if (m.protocolVersion !== PROTOCOL_VERSION) {
      conn.send({ t: "error", code: "version" }); conn.close(); return;
    }
    // 対局中の復帰（席トークン照合）
    if (this.inGame) {
      const rj = m.rejoin;
      if (rj && this.seatTokens.get(rj.seat) === rj.token) {
        const seat = rj.seat;
        const old = this.conns.get(seat);
        if (old && old !== conn) { try { old.close(); } catch {} }
        this.conns.set(seat, conn);
        conn._seat = seat;
        if (m.name) this.seatNames.set(seat, String(m.name).slice(0, 20));
        conn.send({ t: "welcome", seat, token: rj.token });
        conn.send({ t: "start", yourSeat: seat });
        this.controller._note(`${this.seatNames.get(seat)} が復帰しました`, "info");
        this._updatePause();          // 全員揃えば再開
        this._pushStates();
      } else {
        conn.send({ t: "error", code: "in_progress" }); conn.close();
      }
      return;
    }
    // ロビー参加（募集席のみ）
    let seat = -1;
    for (let s = 1; s <= this.openSeats; s++) {
      if (!this.seatNames.has(s)) { seat = s; break; }
    }
    if (seat < 0) { conn.send({ t: "error", code: "full" }); conn.close(); return; }
    const token = randomToken();
    this.conns.set(seat, conn);
    this.seatNames.set(seat, (m.name || "ゲスト").slice(0, 20));
    this.seatTokens.set(seat, token);
    conn._seat = seat;
    conn.send({ t: "welcome", seat, token });
    this._broadcastLobby();
  }

  _onDisconnect(conn) {
    const seat = conn._seat;
    if (seat === undefined || this.conns.get(seat) !== conn) return;
    this.conns.delete(seat);
    if (this.inGame && this.controller) {
      // AI代打はしない: 一時停止して復帰を待つ
      this._updatePause();
      this._pushStates();
    } else {
      this.seatNames.delete(seat);
      this.seatTokens.delete(seat);
      this._broadcastLobby();
    }
  }

  // 未接続の remote 席があれば一時停止、全員揃えば再開
  _updatePause() {
    if (!this.controller || this.controller.matchEnded ||
        this.controller.state.isTerminal()) {
      if (this.controller) this.controller.setPaused(null);
      return;
    }
    const missing = [];
    for (let s = 0; s < this.tableSize; s++) {
      if (this.controller.seats[s].kind === "remote" && !this.conns.has(s)) {
        missing.push(this.seatNames.get(s) || `席${s + 1}`);
      }
    }
    this.controller.setPaused(
      missing.length ? `${missing.join("・")} の再接続を待っています…` : null);
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
    if (this.controller.matchEnded || !this.controller.nextRound()) this.rematch();
  }

  rematch() {
    if (!this.inGame) return;
    const seats = this.controller.seats.map((s) => ({ ...s }));
    this.controller = new GameController(this.tableSize, seats, this.rounds,
                                         () => this._pushStates());
    this.proposal = null;
    for (const [seat, conn] of this.conns) conn.send({ t: "start", yourSeat: seat });
    this._pushStates();
    this.controller.advance();
  }

  // ---- 合意によるその場終了 ----
  _humanSeats() {
    return this.controller.seats
      .map((s, i) => ({ ...s, i }))
      .filter((s) => s.kind !== "ai")
      .map((s) => s.i);
  }

  proposeEnd(fromSeat) {
    if (!this.controller || this.controller.matchEnded || this.proposal) return;
    const humans = this._humanSeats();
    if (humans.length <= 1) {           // 人間が自分だけなら即終了
      this.controller.endMatch();
      this._pushStates();
      return;
    }
    this.proposal = { from: fromSeat, votes: { [fromSeat]: true } };
    this._pushStates();
  }

  vote(seat, agree) {
    if (!this.proposal) return;
    if (!agree) {
      this.proposal = null;
      this.controller._note("対戦終了の提案は同意されなかったため続行します", "info");
      this._pushStates();
      return;
    }
    this.proposal.votes[seat] = true;
    const humans = this._humanSeats();
    if (humans.every((s) => this.proposal.votes[s])) {
      this.proposal = null;
      this.controller.endMatch();
    }
    this._pushStates();
  }

  // 復帰を待ちきれない場合（ホストのみ）: 対戦をその場で終了
  forceEnd() {
    if (!this.controller) return;
    this.controller.endMatch("切断のため対戦を終了しました");
    this.proposal = null;
    this._pushStates();
  }

  _viewFor(seat) {
    const v = this.controller.view(seat);
    if (this.proposal) {
      const names = this.controller.names();
      v.endProposal = {
        fromName: names[this.proposal.from],
        youVoted: !!this.proposal.votes[seat],
        waiting: this._humanSeats().filter((s) => !this.proposal.votes[s]).map((s) => names[s]),
      };
    }
    return v;
  }

  _pushStates() {
    if (!this.controller) return;
    for (const [seat, conn] of this.conns) {
      try { conn.send({ t: "state", view: this._viewFor(seat) }); } catch {}
    }
    this.cb.onState(this._viewFor(0));
    this._persist();
  }

  _persist() {
    if (!this.inGame || !this.controller) return;
    const c = this.controller;
    const matchOver = c.matchEnded ||
      (c.state.isTerminal() && c.round >= c.totalRounds);
    if (matchOver) {   // 終了済みマッチは復帰対象にしない
      try { sessionStorage.removeItem(STORE_HOST); } catch {}
      return;
    }
    try {
      sessionStorage.setItem(STORE_HOST, JSON.stringify({
        code: this.code,
        hostName: this.hostName,
        tableSize: this.tableSize,
        rounds: this.rounds,
        openSeats: this.openSeats,
        seatNames: [...this.seatNames],
        seatTokens: [...this.seatTokens],
        snapshot: this.controller.snapshot(),
      }));
    } catch {}
  }

  // ホスト自身の操作
  play(tiles) { return this.controller ? this.controller.play(0, tiles) : "未開始"; }
  pass() { return this.controller ? this.controller.pass(0) : "未開始"; }
  hostProposeEnd() { this.proposeEnd(0); }
  hostVote(agree) { this.vote(0, agree); }

  destroy() {
    try { sessionStorage.removeItem(STORE_HOST); } catch {}
    try { this.peer && this.peer.destroy(); } catch {}
    this.conns.clear();
  }
}

// ---------------------------------------------------------------------------
export class GuestSession {
  /**
   * cb: {onJoined({seat, token}), onLobby(seats), onStart(), onState(view),
   *      onReject(reason), onError(msg), onHostLost(), onReconnecting(attempt)}
   * rejoin: {seat, token}（リロード復帰時）
   */
  constructor(guestName, code, cb, rejoin = null) {
    this.name = guestName;
    this.code = code;
    this.cb = cb;
    this.seat = rejoin ? rejoin.seat : -1;
    this.token = rejoin ? rejoin.token : null;
    this.started = !!rejoin;     // 対局開始済みか（切断時にリトライするか）
    this.stopped = false;
    this.attempt = 0;
    this._connect();
  }

  static loadResume() {
    try {
      const raw = sessionStorage.getItem(STORE_GUEST);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d && d.code && d.token ? d : null;
    } catch { return null; }
  }

  _progress(msg) { this.cb.onProgress && this.cb.onProgress(msg); }

  _fail(msg) {
    clearTimeout(this._connTimer);
    if (this.stopped) return;
    if (this.started) { this._scheduleRetry(); return; }
    this.cb.onError(msg);
    try { this.peer && this.peer.destroy(); } catch {}
  }

  _connect() {
    if (this.stopped) return;
    try { this.peer && this.peer.destroy(); } catch {}
    this.peer = newPeer();
    this.alive = false;
    this._stage = "signaling";
    this._progress("仲介サーバーに接続中…");
    // 初回接続の見切りタイマー（段階に応じた正確なメッセージ）
    clearTimeout(this._connTimer);
    this._connTimer = setTimeout(() => {
      if (this.stopped || this.alive) return;
      if (this._stage === "signaling") {
        this._fail("仲介サーバーに接続できません。ネットワークやファイアウォールをご確認ください");
      } else {
        this._fail("ホストとの直接接続に失敗しました（NAT越え失敗の可能性）。" +
                   "タイトルの「接続診断」で TURN の状態を確認してください");
      }
    }, CONNECT_TIMEOUT_MS);

    this.peer.on("error", (e) => {
      if (this.stopped) return;
      if (this.started) { this._scheduleRetry(); return; }
      if (e.type === "peer-unavailable") {
        this._fail("その部屋は見つかりません（コードの誤り、またはホストが部屋を閉じました）");
      } else if (["network", "server-error", "socket-error", "socket-closed"].includes(e.type)) {
        this._fail("仲介サーバーに到達できません（" + e.type + "）。回線を変えて再度お試しください");
      } else {
        this._fail("接続エラー: " + e.type);
      }
    });

    this.peer.on("open", () => {
      this._stage = "connecting";
      this._progress("ホストと接続中…（NAT越え）");
      this.conn = this.peer.connect(peerId(this.code), { reliable: true });
      // ICE失敗の検知（peerConnection はネゴシエーション開始後に生える）
      const watchIce = setInterval(() => {
        const pc = this.conn && this.conn.peerConnection;
        if (!pc) return;
        clearInterval(watchIce);
        pc.addEventListener("iceconnectionstatechange", () => {
          if (pc.iceConnectionState === "failed" && !this.alive) {
            this._fail("ホストとの直接接続に失敗しました（NAT越え失敗）。" +
                       "TURN中継にも到達できていません。「接続診断」をご確認ください");
          }
        });
      }, 300);
      this.conn.on("open", () => {
        clearTimeout(this._connTimer);
        clearInterval(watchIce);
        this.alive = true;
        this._stage = "open";
        this._progress(null);
        this.attempt = 0;
        const hello = { t: "hello", name: this.name, protocolVersion: PROTOCOL_VERSION };
        if (this.token !== null) hello.rejoin = { seat: this.seat, token: this.token };
        this.conn.send(hello);
        clearInterval(this._pingTimer);
        this._pingTimer = setInterval(() => {
          try { this.conn.send({ t: "ping" }); } catch {}
        }, PING_INTERVAL_MS);
      });
      this.conn.on("data", (m) => this._onData(m));
      const lost = () => {
        if (this.stopped || !this.alive) return;
        this.alive = false;
        clearInterval(this._pingTimer);
        if (this.started) this._scheduleRetry();
        else this.cb.onHostLost();
      };
      this.conn.on("close", lost);
      this.conn.on("error", lost);
    });
  }

  _scheduleRetry() {
    if (this.stopped) return;
    this.attempt++;
    if (this.attempt > GUEST_RETRY_MAX) { this.cb.onHostLost(); return; }
    this.cb.onReconnecting(this.attempt);
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._connect(), GUEST_RETRY_MS);
  }

  _onData(m) {
    if (!m || typeof m !== "object") return;
    switch (m.t) {
      case "welcome":
        this.seat = m.seat;
        this.token = m.token;
        this.cb.onJoined({ seat: m.seat, token: m.token, code: this.code });
        break;
      case "error": {
        const msgs = { full: "満席です", in_progress: "対局中のため参加できません",
                       version: "バージョンが異なります（ページを更新してください）" };
        if (this.started) this._scheduleRetry();
        else this.cb.onError(msgs[m.code] || m.code);
        break;
      }
      case "lobby": this.cb.onLobby(m.seats); break;
      case "start": this.started = true; this.cb.onStart(); break;
      case "state": this.started = true; this.cb.onState(m.view); break;
      case "reject": this.cb.onReject(m.reason); break;
      case "pong": break;
    }
  }

  play(tiles) { try { this.conn.send({ t: "action", kind: "play", tiles }); } catch {} return null; }
  pass() { try { this.conn.send({ t: "action", kind: "pass" }); } catch {} return null; }
  proposeEnd() { try { this.conn.send({ t: "endPropose" }); } catch {} }
  voteEnd(agree) { try { this.conn.send({ t: "endVote", agree }); } catch {} }

  destroy() {
    this.stopped = true;
    clearInterval(this._pingTimer);
    clearTimeout(this._retryTimer);
    clearTimeout(this._connTimer);
    try { sessionStorage.removeItem(STORE_GUEST); } catch {}
    try { this.peer && this.peer.destroy(); } catch {}
  }
}
