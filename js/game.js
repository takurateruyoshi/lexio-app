// game.js — GameController: ソロ/ホスト共通の権威的ゲーム進行 + プレイヤー別ビュー生成
"use strict";
import {
  standardConfig, GameState, classify, beats, canBeat, enumerateMelds,
  legalMoves, roundScores, meldText, tileRank, tileSuit, tileStrength,
  compareKeys, fullDeck, startingPlayer, SUIT_CLASS, SUIT_LABEL, SUIT_GLYPH,
} from "./engine.js";
import { BeliefState, chooseMove } from "./ai.js";
import { getTheta } from "./model.js";
import { CARD_DEFS, buildDeck, jokerRange, JOKER_BASE } from "./cards.js";

export function tileJson(t, maxRank) {
  const s = tileSuit(t);
  return {
    id: t, rank: tileRank(t), suit: s,
    suit_class: SUIT_CLASS[s], suit_label: SUIT_LABEL[s], glyph: SUIT_GLYPH[s],
    strength: tileStrength(t, maxRank),
    joker: t >= 1000,
  };
}

const AI_MIN_DELAY_MS = 650;   // AI手番の演出用ディレイ（既定値）
const INITIAL_POINTS = 64;     // 持ち点の初期値

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
    opts = { theta: getTheta(), ...opts };
    if (this.worker) {
      const id = ++this._id;
      const payload = {
        id,
        numPlayers: state.cfg.numPlayers,
        state: state.toJSON(),
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
   * aiOpts: {minDelayMs, budgetMs, totalPlayouts, turnLimitSec} 観戦/研究/ホスト設定
   */
  constructor(numPlayers, seats, totalRounds, onUpdate, aiOpts = {}) {
    this.cfg = standardConfig(numPlayers);
    this.seats = seats.map((s) => ({ ...s }));
    this.aiOpts = { ...aiOpts };
    this.turnLimitSec = Math.max(0, aiOpts.turnLimitSec | 0);  // 0=無制限
    this._turnDeadline = null;
    // Neoモード（スペシャルカード）: 2人戦は対象外
    this.neo = !!aiOpts.neo && numPlayers >= 3;
    this.cards = [];                 // seat -> カードID配列
    this.cardUsedRound = [];         // seat -> このラウンドで使用済みか
    this.forcePass = [];             // seat -> 次の手番を強制パス（失われた権利）
    this.endingQueue = null;         // 精算フェーズの問い合わせ順
    if (this.neo) {
      const deck = buildDeck();
      for (let p = 0; p < numPlayers; p++) this.cards.push(deck.splice(0, 3));
    }
    this.records = [];             // ラウンドごとの牌譜
    this.totalRounds = Math.max(1, Math.min(99, totalRounds | 0));
    this.round = 1;
    this.totals = new Array(numPlayers).fill(INITIAL_POINTS);   // 持ち点（64点開始）
    this.onUpdate = onUpdate || (() => {});
    this.busy = false;             // AI進行中
    this.paused = false;           // 切断待機などの一時停止
    this.pausedReason = null;
    this.matchEnded = false;       // 合意等によるマッチ終了
    this.ai = new AiRunner();
    this._startRound();
  }

  // ---- リロード復帰 ----
  snapshot() {
    return {
      v: 1,
      numPlayers: this.cfg.numPlayers,
      totalRounds: this.totalRounds,
      round: this.round,
      totals: [...this.totals],
      seats: this.seats.map((s) => ({ ...s })),
      state: this.state.toJSON(),
      log: this.log.slice(-40),
      trick: this.trick.map((e) => ({ player: e.player, tiles: [...e.tiles] })),
      scores: this.scores ? [...this.scores] : null,
      matchEnded: this.matchEnded,
      aiOpts: { ...this.aiOpts, turnLimitSec: this.turnLimitSec, neo: this.neo },
      cards: this.neo ? this.cards.map((c) => [...c]) : null,
      cardUsedRound: this.neo ? [...this.cardUsedRound] : null,
      forcePassArr: this.neo ? [...this.forcePass] : null,
      beliefs: Object.fromEntries(
        [...this.beliefs].map(([s, b]) => [s, b.toJSON()])),
    };
  }

  static restore(snap, onUpdate) {
    const c = Object.create(GameController.prototype);
    c.cfg = standardConfig(snap.numPlayers);
    c.seats = snap.seats.map((s) => ({ ...s }));
    c.totalRounds = snap.totalRounds;
    c.round = snap.round;
    c.totals = [...snap.totals];
    c.onUpdate = onUpdate || (() => {});
    c.busy = false;
    c.paused = false;
    c.pausedReason = null;
    c.matchEnded = !!snap.matchEnded;
    c.aiOpts = { ...(snap.aiOpts || {}) };
    c.turnLimitSec = Math.max(0, (c.aiOpts.turnLimitSec || 0) | 0);
    c._turnDeadline = null;
    c.neo = !!c.aiOpts.neo;
    c.cards = snap.cards ? snap.cards.map((x) => [...x]) : [];
    c.cardUsedRound = snap.cardUsedRound ? [...snap.cardUsedRound]
      : new Array(c.cfg.numPlayers).fill(false);
    c.forcePass = snap.forcePassArr ? [...snap.forcePassArr]
      : new Array(c.cfg.numPlayers).fill(false);
    c.endingQueue = null;
    c.records = [];
    c._rec = { round: snap.round, seats: [], deal: [], moves: [], scores: null }; // 復元後の途中記録は簡略
    c.ai = new AiRunner();
    c.state = GameState.fromJSON(c.cfg, snap.state);
    c.log = (snap.log || []).map((e) => ({ ...e }));
    c.trick = (snap.trick || []).map((e) => ({ player: e.player, tiles: [...e.tiles] }));
    c.scores = snap.scores ? [...snap.scores] : null;
    c.beliefs = new Map();
    for (const [s, bj] of Object.entries(snap.beliefs || {})) {
      c.beliefs.set(Number(s), BeliefState.fromJSON(c.cfg, bj));
    }
    c._armTurnTimer();
    return c;
  }

  // ---- 一時停止（切断待機） ----
  setPaused(reason) {
    this.paused = !!reason;
    this.pausedReason = reason || null;
    this._armTurnTimer();     // 停止中は解除・再開でリセット
    this.onUpdate();
    if (!this.paused) this.advance();
  }

  // ---- 合意等によるマッチ即時終了（累計で最終順位） ----
  endMatch(note) {
    if (this.matchEnded) return;
    this.matchEnded = true;
    this.paused = false;
    this.pausedReason = null;
    clearTimeout(this._turnTimer);
    this._turnDeadline = null;
    if (this.scores === null) {
      // 進行中のラウンドは中断扱い（今回の収支 0、累計のみで判定）
      this.scores = new Array(this.cfg.numPlayers).fill(0);
    }
    this._note(note || "合意により対戦を終了しました", "finish");
    this.onUpdate();
  }

  _startRound() {
    if (this.aiOpts.fixedDeal) {
      // チュートリアル等の固定配牌
      const st = new GameState(this.cfg);
      st.hands = this.aiOpts.fixedDeal.map((h) => [...h].sort((a, b) => a - b));
      const used = new Set(st.hands.flat());
      st.hidden = fullDeck(this.cfg).filter((t) => !used.has(t));
      st.leader = startingPlayer(st.hands);
      st.turn = st.leader;
      st.passed = new Array(this.cfg.numPlayers).fill(false);
      st.played = Array.from({ length: this.cfg.numPlayers }, () => []);
      st.finished = [];
      this.state = st;
    } else {
      this.state = GameState.deal(this.cfg);
    }
    this.log = [];
    this.trick = [];               // 現在のトリック [{player, tiles}]
    this.scores = null;
    this.cardUsedRound = new Array(this.cfg.numPlayers).fill(false);
    this.forcePass = new Array(this.cfg.numPlayers).fill(false);
    this.endingQueue = null;
    // 牌譜（このラウンド）
    this._rec = {
      round: this.round,
      seats: this.seats.map((s) => ({ kind: s.kind, name: s.name })),
      deal: this.state.hands.map((h) => [...h]),
      moves: [],
      scores: null,
    };
    this.beliefs = new Map();      // seat -> BeliefState（AI席のみ）
    for (let p = 0; p < this.cfg.numPlayers; p++) {
      if (this.seats[p].kind === "ai") {
        this.beliefs.set(p, new BeliefState(this.cfg, p, this.state.hands[p]));
      }
    }
    this._note(`ラウンド ${this.round}/${this.totalRounds} 開始: `
      + `${this.cfg.numPlayers}人戦 / 数字1〜${this.cfg.maxRank} / 配牌${this.cfg.handSize}枚`);
    this._note(`${this.names()[this.state.leader]} のリードから開始（☁3 保持者）`);
    this._armTurnTimer();
  }

  // 次のラウンドへ（終局後のみ）
  nextRound() {
    if (this.matchEnded) return false;
    if (this.scores === null || this.round >= this.totalRounds) return false;
    this.round++;
    this._startRound();
    this.onUpdate();
    this.advance();
    return true;
  }

  // ---- 思考時間制限（人間の手番のみ・時間切れで自動パス/最弱リード） ----
  _armTurnTimer() {
    clearTimeout(this._turnTimer);
    this._turnDeadline = null;
    if (!this.turnLimitSec) return;
    const st = this.state;
    if (st.isTerminal() || this.paused || this.matchEnded) return;
    const seat = st.turn;
    if (this.seats[seat].kind === "ai") return;
    this._turnDeadline = Date.now() + this.turnLimitSec * 1000;
    this._turnTimer = setTimeout(() => this._onTurnTimeout(seat), this.turnLimitSec * 1000);
  }

  _onTurnTimeout(seat) {
    const st = this.state;
    if (st.turn !== seat || st.isTerminal() || this.paused || this.matchEnded) return;
    this._note(`⏱ ${this.names()[seat]} は時間切れ`, "pass");
    if (st.current !== null) {
      this.pass(seat);
      return;
    }
    // リードは最弱の役を自動で出す
    let best = null;
    for (const m of legalMoves(st.hands[seat], null, this.cfg)) {
      if (m === null) continue;
      if (best === null || m.size < best.size ||
          (m.size === best.size && compareKeys(m.key, best.key) < 0)) best = m;
    }
    if (best) this.play(seat, best.tiles);
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
    this._rec.moves.push({
      seat,
      tiles: meld === null ? null : [...meld.tiles],
      counts: this.state.hands.map((h) => h.length),   // 手番時点の残枚数
      currentBefore: this.state.current ? [...this.state.current.tiles] : null,
      thought: this._lastThought || null,
    });
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
    if (this.state.isTerminal() && this.scores === null && this.endingQueue === null) {
      this._onRoundEnd();
    }
    this._armTurnTimer();
  }

  // ---- ラウンド終了（Neoでは精算前にENDINGカードの使用機会がある） ----
  _onRoundEnd() {
    const base = roundScores(this.state);
    const n = this.cfg.numPlayers;
    const queue = [];
    if (this.neo) {
      const order = [...Array(n).keys()].sort((a, b) => base[b] - base[a]); // 1位から
      const winner = this.state.finished[0];
      const last = order[order.length - 1];
      for (const s of order) {
        if (this.seats[s].kind === "ai" || this.cardUsedRound[s]) continue;  // AIはv1では使わない
        for (const cid of this.cards[s]) {
          const def = CARD_DEFS[cid];
          if (!def || def.type !== "ending") continue;
          if (cid === "winner_takes" && s !== winner) continue;
          if (cid === "helping_hand" && s !== last) continue;
          queue.push({ seat: s, cardId: cid });
        }
      }
    }
    if (!queue.length) { this._finalizeScores([]); return; }
    this.endingQueue = { list: queue, idx: 0, mods: [] };
    this._note("精算前 — スペシャルカードの使用機会があります", "info");
    clearTimeout(this._endTimer);
    this._endTimer = setTimeout(() => this._skipEndingAll(), 20000);
  }

  _skipEndingAll() {
    if (this.endingQueue) this._finalizeScores(this.endingQueue.mods);
  }

  // 精算にENDINGカードの効果を適用したスコアを計算
  _settlement(mods) {
    const n = this.cfg.numPlayers;
    const remain = this.state.hands.map((h) => h.length);
    const mult = this.state.hands.map((h) =>
      Math.pow(2, h.filter((t) => tileRank(t) === 2).length));
    const pay = Array.from({ length: n }, () => new Array(n).fill(0)); // pay[i][j] = i→j
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j && remain[i] > remain[j]) pay[i][j] = (remain[i] - remain[j]) * mult[i];
      }
    }
    const helping = mods.find((m) => m.cardId === "helping_hand");
    if (helping) {
      for (let j = 0; j < n; j++) if (pay[helping.seat][j] > 0) pay[helping.seat][j] = 1;
    }
    const wt = mods.find((m) => m.cardId === "winner_takes");
    if (wt) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i !== wt.seat && j !== wt.seat && pay[i][j] > 0) {
            pay[i][wt.seat] += pay[i][j];   // 敗者間の支払いを勝者が回収
            pay[i][j] = 0;
          }
        }
      }
    }
    const score = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) { score[i] -= pay[i][j]; score[j] += pay[i][j]; }
    }
    return score;
  }

  _finalizeScores(mods) {
    clearTimeout(this._endTimer);
    this.endingQueue = null;
    this.scores = this.neo ? this._settlement(mods) : roundScores(this.state);
    for (let i = 0; i < this.cfg.numPlayers; i++) this.totals[i] += this.scores[i];
    this._note(`ラウンド ${this.round}/${this.totalRounds} 終了。スコアを精算します。`, "info");
    this._rec.scores = [...this.scores];
    this._rec.finished = [...this.state.finished];
    this._rec.totalsAfter = [...this.totals];
    this._rec.cardMods = mods.map((m) => ({ ...m }));
    this.records.push(this._rec);
    this.onUpdate();
  }

  // 精算フェーズの応答（use=trueでカード使用）
  respondEnding(seat, use) {
    const q = this.endingQueue;
    if (!q) return "精算フェーズではありません";
    const cur = q.list[q.idx];
    if (!cur || cur.seat !== seat) return "あなたの選択の番ではありません";
    if (use) {
      this._takeCard(seat, cur.cardId);
      q.mods.push({ seat, cardId: cur.cardId });
      this._note(`${this.names()[seat]} が「${CARD_DEFS[cur.cardId].name}」を使用！`, "play");
      // 同一プレイヤーの残りの問い合わせを除去（1ラウンド1枚）
      q.list = q.list.filter((e, i) => i <= q.idx || e.seat !== seat);
    }
    q.idx++;
    while (q.idx < q.list.length &&
           this.cardUsedRound[q.list[q.idx].seat] && !use) q.idx++;
    if (q.idx >= q.list.length) this._finalizeScores(q.mods);
    else this.onUpdate();
    return null;
  }

  // ---- Neo: カード共通処理 ----
  _takeCard(seat, cardId) {
    const i = this.cards[seat].indexOf(cardId);
    if (i >= 0) this.cards[seat].splice(i, 1);
    this.cardUsedRound[seat] = true;
  }

  _cardCheck(seat, cardId) {
    if (!this.neo) return "Neoモードではありません";
    if (this.paused || this.matchEnded) return "今は使えません";
    if (!this.cards[seat] || !this.cards[seat].includes(cardId)) return "そのカードを持っていません";
    if (this.cardUsedRound[seat]) return "スペシャルカードは1ラウンドに1枚までです";
    return null;
  }

  // 牌と一緒に使うカード（ジョーカー / 失われた権利 / 不要なギフト）
  // card: {id, rank?, target?, gift?}
  playWithCard(seat, tileIds, card) {
    const err0 = this._cardCheck(seat, card.id);
    if (err0) return err0;
    if (this.state.isTerminal()) return "ゲームは終了しています";
    if (this.state.turn !== seat) return "あなたの手番ではありません";
    const def = CARD_DEFS[card.id];
    const hand = this.state.hands[seat];
    let allTiles = tileIds.map(Number);
    if (!allTiles.every((t) => hand.includes(t))) return "手札にないタイルが含まれています";

    if (def.type === "joker") {
      const range = jokerRange(this.cfg.numPlayers);
      if (!range) return "この人数ではジョーカーを使えません";
      const r = card.rank | 0;
      if (r < range[0] || r > range[1]) return `このジョーカーは ${range[0]}〜${range[1]} の代わりにできます`;
      // 禁止は「同一の牌（同じ色・同じ数字）」との同時出しのみ。
      // 同数字でも色が違えばペア/トリプル/フルハウス等に使える。
      if (allTiles.includes(r * 4 + def.suit)) return "同じ牌（同じ色・数字）とは一緒に出せません";
      allTiles = [...allTiles, JOKER_BASE + r * 4 + def.suit];
    } else if (card.id === "lost_right") {
      const tgt = card.target | 0;
      if (tgt === seat || tgt < 0 || tgt >= this.cfg.numPlayers ||
          !this.state.hands[tgt].length) return "対象プレイヤーが不正です";
    } else if (card.id === "unwanted_gift") {
      const tgt = card.target | 0;
      if (tgt === seat || tgt < 0 || tgt >= this.cfg.numPlayers ||
          !this.state.hands[tgt].length) return "対象プレイヤーが不正です";
      const gift = card.gift | 0;
      if (!hand.includes(gift) || allTiles.includes(gift)) return "渡す牌が不正です";
    } else {
      return "このカードは牌と一緒には使えません";
    }

    const meld = classify(allTiles, this.cfg.maxRank);
    if (meld === null) return "正当な役ではありません";
    if (!beats(meld, this.state.current)) return "場に出せません（より強い同枚数の役が必要）";

    this._takeCard(seat, card.id);
    this._note(`${this.names()[seat]} が「${def.name}」を使用！`, "play");
    this._applyMove(seat, meld);

    // 追加効果
    if (card.id === "lost_right") {
      this.forcePass[card.target | 0] = true;
      this._note(`${this.names()[card.target | 0]} は次の手番を強制パスされる`, "pass");
    } else if (card.id === "unwanted_gift" && !this.state.isTerminal()) {
      const tgt = card.target | 0, gift = card.gift | 0;
      const hi = this.state.hands[seat].indexOf(gift);
      if (hi >= 0) {
        this.state.hands[seat].splice(hi, 1);
        this.state.hands[tgt].push(gift);
        this.state.hands[tgt].sort((a, b) => a - b);
        this._note(`${this.names()[seat]} が牌1枚を ${this.names()[tgt]} に押し付けた！`, "pass");
        if (!this.state.hands[seat].length && !this.state.finished.includes(seat)) {
          this.state.finished.push(seat);   // 渡して0枚なら上がり
        }
      }
    }
    if (this.state.isTerminal() && this.scores === null && this.endingQueue === null) {
      this._onRoundEnd();
    }
    this.advance();
    return null;
  }

  // 新しい始まり: 配牌直後のみ・全員の牌を配り直す
  useNewBeginning(seat) {
    const err0 = this._cardCheck(seat, "new_beginning");
    if (err0) return err0;
    if (this._rec.moves.length > 0) return "最初の牌が出た後は使えません";
    this._takeCard(seat, "new_beginning");
    this.state = GameState.deal(this.cfg);
    this.trick = [];
    this._rec.deal = this.state.hands.map((h) => [...h]);
    this.beliefs = new Map();
    for (let p = 0; p < this.cfg.numPlayers; p++) {
      if (this.seats[p].kind === "ai") {
        this.beliefs.set(p, new BeliefState(this.cfg, p, this.state.hands[p]));
      }
    }
    this._note(`${this.names()[seat]} が「新しい始まり」を使用 — 全員の牌を配り直し！`, "play");
    this._armTurnTimer();
    this.onUpdate();
    this.advance();
    return null;
  }

  // 人間/リモートの手番まで AI を進める（非同期）
  async advance() {
    if (this.busy || this.paused || this.matchEnded) return;
    this.busy = true;
    this.onUpdate();
    let guard = 0;
    while (!this.state.isTerminal() && !this.paused && !this.matchEnded && guard++ < 300) {
      const p = this.state.turn;
      // 失われた権利: 次の手番を強制パス（リード時は効果消滅）
      if (this.forcePass[p]) {
        this.forcePass[p] = false;
        if (this.state.current !== null) {
          this._note(`${this.names()[p]} は強制パス（失われた権利）`, "pass");
          this._applyMove(p, null);
          this.onUpdate();
          continue;
        }
      }
      if (this.seats[p].kind !== "ai") break;
      const belief = this.beliefs.get(p);
      belief.syncMyHand(this.state.hands[p]);
      const t0 = Date.now();
      const chooseOpts = {};
      if (this.aiOpts.budgetMs) chooseOpts.budgetMs = this.aiOpts.budgetMs;
      if (this.aiOpts.totalPlayouts) chooseOpts.totalPlayouts = this.aiOpts.totalPlayouts;
      const { moveTiles, thought } = await this.ai.choose(this.state, p, belief, chooseOpts);
      const wait = (this.aiOpts.minDelayMs ?? AI_MIN_DELAY_MS) - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      let meld = moveTiles ? classify(moveTiles, this.cfg.maxRank) : null;
      // セーフガード: AIの手を適用前に再検証（キャッシュ不整合等での違反手を遮断）
      if (meld !== null) {
        const hand = this.state.hands[p];
        const legal = meld.tiles.every((t) => hand.includes(t)) && beats(meld, this.state.current);
        if (!legal) {
          console.warn("AI move rejected as illegal — falling back", moveTiles);
          if (this.state.current !== null) {
            meld = null;                               // 応手は安全にパス
          } else {
            let best = null;                           // リードは最弱の合法手
            for (const m of legalMoves(hand, null, this.cfg)) {
              if (m === null) continue;
              if (best === null || m.size < best.size ||
                  (m.size === best.size && compareKeys(m.key, best.key) < 0)) best = m;
            }
            meld = best;
          }
        }
      }
      this._lastThought = thought && !thought.forced ? thought : null;
      this._applyMove(p, meld);
      this.onUpdate();
    }
    this.busy = false;
    this.onUpdate();
  }

  // 人間(ローカル/リモート)のアクション。エラー文字列 or null を返す。
  play(seat, tileIds) {
    if (this.paused) return "一時停止中です（切断者の復帰待ち）";
    if (this.matchEnded) return "対戦は終了しています";
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
    if (this.paused) return "一時停止中です（切断者の復帰待ち）";
    if (this.matchEnded) return "対戦は終了しています";
    if (this.state.isTerminal()) return "ゲームは終了しています";
    if (this.state.turn !== seat) return "あなたの手番ではありません";
    if (this.state.current === null) return "リード時はパスできません（何か出してください）";
    this._applyMove(seat, null);
    this.advance();
    return null;
  }

  // seat 視点のビュー（ローカル描画/ネットワーク送信兼用）
  // revealAll: 観戦モードで全席の手札を公開する
  view(seat, revealAll = false) {
    const st = this.state;
    const mr = this.cfg.maxRank;
    const names = this.names();
    const blocked = this.paused || this.matchEnded;
    const myTurn = st.turn === seat && !st.isTerminal() && !blocked;
    // 表示は常に強さ昇順（最強が右）
    const byStrength = (tiles) =>
      [...tiles].sort((a, b) => tileStrength(a, mr) - tileStrength(b, mr));
    const hand = byStrength(st.hands[seat]);
    return {
      numPlayers: this.cfg.numPlayers,
      maxRank: mr,
      yourSeat: seat,
      yourHand: hand.map((t) => tileJson(t, mr)),
      currentMeld: st.current === null ? null : {
        text: meldText(st.current),
        tiles: byStrength(st.current.tiles).map((t) => tileJson(t, mr)),
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
      matchOver: this.matchEnded || (st.isTerminal() && this.round >= this.totalRounds),
      paused: this.paused,
      pausedReason: this.pausedReason,
      turnLimit: this.turnLimitSec,
      turnDeadline: this._turnDeadline,
      neo: this.neo,
      myCards: this.neo ? this.cards[seat].map((id) => ({ id, ...CARD_DEFS[id] })) : null,
      cardUsed: this.neo ? this.cardUsedRound[seat] : false,
      cardCounts: this.neo ? this.cards.map((c) => c.length) : null,
      canNewBeginning: this.neo && this._rec.moves.length === 0 &&
        !this.cardUsedRound[seat] && this.cards[seat].includes("new_beginning"),
      endOffer: (this.endingQueue && this.endingQueue.list[this.endingQueue.idx] &&
                 this.endingQueue.list[this.endingQueue.idx].seat === seat)
        ? { cardId: this.endingQueue.list[this.endingQueue.idx].cardId,
            name: CARD_DEFS[this.endingQueue.list[this.endingQueue.idx].cardId].name }
        : null,
      settling: this.endingQueue !== null,
      prevResult: (() => {   // 一局前の結果（対局中の振り返り用）
        const done = this.records.filter((r) => r.scores !== null);
        const prev = st.isTerminal() ? done[done.length - 2] : done[done.length - 1];
        if (!prev) return null;
        return {
          round: prev.round,
          winner: prev.finished && prev.finished.length ? names[prev.finished[0]] : null,
          scores: prev.seats.map((s, i) => ({
            name: names[i] ?? s.name,
            score: prev.scores[i],
            total: prev.totalsAfter ? prev.totalsAfter[i] : null,
          })),
        };
      })(),
      players: this.seats.map((s, i) => ({
        index: i, name: names[i], kind: s.kind,
        count: st.hands[i].length,
        points: this.totals[i],
        isTurn: st.turn === i && !st.isTerminal(),
        isYou: i === seat,
        passed: st.passed[i] && !st.finished.includes(i),
        finished: st.finished.includes(i),
      })),
      trickPlays: this.trick.map((e) => ({
        player: e.player, tiles: byStrength(e.tiles).map((t) => tileJson(t, mr)),
      })),
      seats: this.seats.map((_, i) => ({
        index: i,
        history: st.played[i].map((m) => byStrength(m.tiles).map((t) => tileJson(t, mr))),
      })),
      log: this.log.slice(-40),
      terminal: st.isTerminal() || this.matchEnded,
      scores: this.scores === null ? null : this.seats.map((_, i) => ({
        name: names[i],
        score: this.scores[i],
        total: this.totals[i],
        count: st.hands[i].length,
        twos: st.hands[i].filter((t) => tileRank(t) === 2).length,
      })),
      winner: st.finished.length ? names[st.finished[0]] : null,
      allHands: !revealAll ? null : st.hands.map((h) =>
        byStrength(h).map((t) => tileJson(t, mr))),
    };
  }
}
