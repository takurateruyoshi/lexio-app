// game.js — GameController: ソロ/ホスト共通の権威的ゲーム進行 + プレイヤー別ビュー生成
"use strict";
import {
  standardConfig, GameState, classify, beats, canBeat, enumerateMelds,
  legalMoves, roundScores, meldText, tileRank, tileSuit, tileStrength,
  SUIT_CLASS, SUIT_LABEL, SUIT_GLYPH,
} from "./engine.js";
import { BeliefState, chooseMove } from "./ai.js";

export function tileJson(t, maxRank) {
  const s = tileSuit(t);
  return {
    id: t, rank: tileRank(t), suit: s,
    suit_class: SUIT_CLASS[s], suit_label: SUIT_LABEL[s], glyph: SUIT_GLYPH[s],
    strength: tileStrength(t, maxRank),
  };
}

const AI_MIN_DELAY_MS = 650;   // AI手番の演出用ディレイ

// AI実行: Web Worker(可能なら) / メインスレッド fallback
class AiRunner {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this._id = 0;
    try {
      this.worker = new Worker(new URL("./ai.worker.js", import.meta.url), { type: "module" });
      this.worker.onmessage = (ev) => {
        const { id, moveTiles, thought, error } = ev.data;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (error) p.reject(new Error(error));
        else p.resolve({ moveTiles, thought });
      };
      this.worker.onerror = () => { this.worker = null; };
    } catch { this.worker = null; }
  }

  async choose(state, me, belief, opts) {
    if (this.worker) {
      const id = ++this._id;
      const payload = {
        id,
        numPlayers: state.cfg.numPlayers,
        state: {
          hands: state.hands, hidden: state.hidden,
          currentTiles: state.current ? state.current.tiles : null,
          leader: state.leader, turn: state.turn, passed: state.passed,
          lastPlayer: state.lastPlayer, finished: state.finished,
        },
        me, belief: belief.toJSON(), opts,
      };
      try {
        return await new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          this.worker.postMessage(JSON.parse(JSON.stringify(payload)));
        });
      } catch { this.worker = null; }
    }
    // fallback: メインスレッド
    const { move, thought } = chooseMove(state, me, belief, opts);
    return { moveTiles: move ? move.tiles : null, thought };
  }
}

export class GameController {
  /**
   * seats: 席ごとの {kind: "human"|"ai"|"remote", name}
   * totalRounds: ラウンド数（累計チップで総合順位）
   * onUpdate(): 状態変化時に呼ばれる（ビューは view(seat) で取得）
   */
  constructor(numPlayers, seats, totalRounds, onUpdate) {
    this.cfg = standardConfig(numPlayers);
    this.seats = seats.map((s) => ({ ...s }));
    this.totalRounds = Math.max(1, totalRounds | 0);
    this.round = 1;
    this.totals = new Array(numPlayers).fill(0);   // 累計チップ
    this.onUpdate = onUpdate || (() => {});
    this.busy = false;             // AI進行中
    this.ai = new AiRunner();
    this._startRound();
  }

  _startRound() {
    this.state = GameState.deal(this.cfg);
    this.log = [];
    this.trick = [];               // 現在のトリック [{player, tiles}]
    this.scores = null;
    this.beliefs = new Map();      // seat -> BeliefState（AI席のみ）
    for (let p = 0; p < this.cfg.numPlayers; p++) {
      if (this.seats[p].kind === "ai") {
        this.beliefs.set(p, new BeliefState(this.cfg, p, this.state.hands[p]));
      }
    }
    this._note(`ラウンド ${this.round}/${this.totalRounds} 開始: `
      + `${this.cfg.numPlayers}人戦 / 数字1〜${this.cfg.maxRank} / 配牌${this.cfg.handSize}枚`);
    this._note(`${this.names()[this.state.leader]} のリードから開始（☁3 保持者）`);
  }

  // 次のラウンドへ（終局後のみ）
  nextRound() {
    if (this.scores === null || this.round >= this.totalRounds) return false;
    this.round++;
    this._startRound();
    this.onUpdate();
    this.advance();
    return true;
  }

  names() { return this.seats.map((s) => s.name); }

  _note(msg, kind = "info", thought = null) {
    this.log.push({ kind, msg, thought });
    if (this.log.length > 80) this.log.shift();
  }

  // 全AI信念に観測を配る
  _broadcastObservation(player, moveTiles) {
    for (const [seat, b] of this.beliefs) {
      if (moveTiles === null) {
        b.observePass(player, this.state.current ? this.state.current.tiles : null);
      } else {
        b.observePlay(player, moveTiles);
      }
    }
  }

  _applyMove(seat, meld) {
    const name = this.names()[seat];
    if (meld === null) {
      this._broadcastObservation(seat, null);
      this._note(`${name} は パス`, "pass", this._lastThought);
    } else {
      this._broadcastObservation(seat, meld.tiles);
      this._note(`${name} が ${meldText(meld)} を出した`, "play", this._lastThought);
      this.trick.push({ player: seat, tiles: [...meld.tiles] });
    }
    this._lastThought = null;
    this.state = this.state.apply(meld);
    if (this.state.current === null) this.trick = [];   // 場が流れた
    if (meld !== null && !this.state.hands[seat].length) {
      this._note(`🏁 ${name} が上がりました！`, "finish");
    }
    if (this.state.isTerminal() && this.scores === null) {
      this.scores = roundScores(this.state);
      for (let i = 0; i < this.cfg.numPlayers; i++) this.totals[i] += this.scores[i];
      this._note(`ラウンド ${this.round}/${this.totalRounds} 終了。スコアを精算します。`, "info");
    }
  }

  // 人間/リモートの手番まで AI を進める（非同期）
  async advance() {
    if (this.busy) return;
    this.busy = true;
    this.onUpdate();
    let guard = 0;
    while (!this.state.isTerminal() && guard++ < 300) {
      const p = this.state.turn;
      if (this.seats[p].kind !== "ai") break;
      const belief = this.beliefs.get(p);
      belief.syncMyHand(this.state.hands[p]);
      const t0 = Date.now();
      const { moveTiles, thought } = await this.ai.choose(this.state, p, belief, {});
      const wait = AI_MIN_DELAY_MS - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const meld = moveTiles ? classify(moveTiles, this.cfg.maxRank) : null;
      this._lastThought = thought && !thought.forced ? thought : null;
      this._applyMove(p, meld);
      this.onUpdate();
    }
    this.busy = false;
    this.onUpdate();
  }

  // 人間(ローカル/リモート)のアクション。エラー文字列 or null を返す。
  play(seat, tileIds) {
    if (this.state.isTerminal()) return "ゲームは終了しています";
    if (this.state.turn !== seat) return "あなたの手番ではありません";
    const hand = this.state.hands[seat];
    if (!tileIds.every((t) => hand.includes(t))) return "手札にないタイルが含まれています";
    const meld = classify(tileIds, this.cfg.maxRank);
    if (meld === null) return "正当な役ではありません（単/ペア/トリプル/5枚役）";
    if (!beats(meld, this.state.current)) {
      return this.state.current === null
        ? "出せません"
        : `場（${meldText(this.state.current)}）より強い同枚数の役が必要です`;
    }
    this._applyMove(seat, meld);
    this.advance();
    return null;
  }

  pass(seat) {
    if (this.state.isTerminal()) return "ゲームは終了しています";
    if (this.state.turn !== seat) return "あなたの手番ではありません";
    if (this.state.current === null) return "リード時はパスできません（何か出してください）";
    this._applyMove(seat, null);
    this.advance();
    return null;
  }

  // 席をAIに切り替える（切断時の引き継ぎ）
  takeOverByAI(seat) {
    if (this.seats[seat].kind === "ai") return;
    const name = this.seats[seat].name;
    this.seats[seat] = { kind: "ai", name: `${name}(AI)` };
    const b = new BeliefState(this.cfg, seat, this.state.hands[seat]);
    // 既知の公開情報を反映
    for (const pl of this.state.played.flat()) for (const t of pl.tiles) b.playedTiles.add(t);
    this.beliefs.set(seat, b);
    this._note(`${name} が切断 → AIが引き継ぎました`, "info");
    this.advance();
  }

  // seat 視点のビュー（ローカル描画/ネットワーク送信兼用）
  view(seat) {
    const st = this.state;
    const mr = this.cfg.maxRank;
    const names = this.names();
    const myTurn = st.turn === seat && !st.isTerminal();
    const hand = [...st.hands[seat]].sort((a, b) => tileStrength(a, mr) - tileStrength(b, mr));
    return {
      numPlayers: this.cfg.numPlayers,
      maxRank: mr,
      yourSeat: seat,
      yourHand: hand.map((t) => tileJson(t, mr)),
      currentMeld: st.current === null ? null : {
        text: meldText(st.current),
        tiles: st.current.tiles.map((t) => tileJson(t, mr)),
        size: st.current.size,
      },
      lastPlayer: st.lastPlayer < 0 ? null : names[st.lastPlayer],
      lastPlayerSeat: st.lastPlayer,
      leader: names[st.leader],
      turn: st.turn,
      turnName: st.isTerminal() ? null : names[st.turn],
      yourTurn: myTurn,
      canPass: myTurn && st.current !== null,
      mustLead: myTurn && st.current === null,
      round: this.round,
      totalRounds: this.totalRounds,
      matchOver: st.isTerminal() && this.round >= this.totalRounds,
      players: this.seats.map((s, i) => ({
        index: i, name: names[i], kind: s.kind,
        count: st.hands[i].length,
        isTurn: st.turn === i && !st.isTerminal(),
        isYou: i === seat,
        passed: st.passed[i] && !st.finished.includes(i),
        finished: st.finished.includes(i),
      })),
      trickPlays: this.trick.map((e) => ({
        player: e.player, tiles: e.tiles.map((t) => tileJson(t, mr)),
      })),
      seats: this.seats.map((_, i) => ({
        index: i,
        history: st.played[i].map((m) => m.tiles.map((t) => tileJson(t, mr))),
      })),
      log: this.log.slice(-40),
      terminal: st.isTerminal(),
      scores: this.scores === null ? null : this.seats.map((_, i) => ({
        name: names[i],
        score: this.scores[i],
        total: this.totals[i],
        count: st.hands[i].length,
        twos: st.hands[i].filter((t) => tileRank(t) === 2).length,
      })),
      winner: st.finished.length ? names[st.finished[0]] : null,
    };
  }
}
