// ai.js — ベイズ信念 + モンテカルロ・ロールアウトAI（全席同一）
// 「パス履歴で条件付けた相手手札のサンプリング」+「候補手ごとの前向きシミュレーション」
"use strict";

import {
  fullDeck, tileRank, tileStrength, shuffle,
  classify, beats, compareKeys, enumerateMelds, canBeat, legalMoves,
  roundScores, meldText,
} from "./engine.js";

const SOFT_PASS_ACCEPT = 0.2;   // 戦略的パスの許容率
const MAX_SAMPLE_TRIES = 40;    // 1サンプルあたりの棄却上限
const MAX_PASS_CONSTRAINTS = 8; // 使うパス制約の上限（新しい順）

// ---------------------------------------------------------------------------
// BeliefState: 公開情報（出牌・パス・残枚数）から相手手札の事後分布をサンプルする
// ---------------------------------------------------------------------------
export class BeliefState {
  constructor(cfg, me, myHand) {
    this.cfg = cfg;
    this.me = me;
    this.myHand = new Set(myHand);
    this.playedTiles = new Set();          // 全員が場に出した牌
    this.passEvents = [];                  // {id, player, meldTiles, laterPlays}
    this._nextId = 0;
  }

  syncMyHand(hand) { this.myHand = new Set(hand); }

  // Worker 受け渡し用
  toJSON() {
    return {
      me: this.me,
      myHand: [...this.myHand],
      playedTiles: [...this.playedTiles],
      passEvents: this.passEvents.map((e) => ({ ...e, meldTiles: [...e.meldTiles],
                                                laterPlays: [...e.laterPlays] })),
    };
  }

  static fromJSON(cfg, data) {
    const b = new BeliefState(cfg, data.me, data.myHand);
    b.playedTiles = new Set(data.playedTiles);
    b.passEvents = data.passEvents.map((e) => ({ ...e }));
    b._nextId = data.passEvents.length;
    return b;
  }

  observePlay(player, meldTiles) {
    for (const t of meldTiles) this.playedTiles.add(t);
    if (player !== this.me) {
      for (const ev of this.passEvents) {
        if (ev.player === player) ev.laterPlays.push(...meldTiles);
      }
    }
  }

  observePass(player, currentMeldTiles) {
    if (player === this.me || currentMeldTiles === null) return;
    this.passEvents.push({
      id: this._nextId++,
      player,
      meldTiles: [...currentMeldTiles],
      laterPlays: [],   // このパスの後にこの人が出した牌（当時は持っていた）
    });
    if (this.passEvents.length > MAX_PASS_CONSTRAINTS) this.passEvents.shift();
  }

  _unknownPool(state) {
    const pool = [];
    for (const t of fullDeck(this.cfg)) {
      if (!this.myHand.has(t) && !this.playedTiles.has(t)) pool.push(t);
    }
    return pool;
  }

  // 1つの世界（相手手札の割当）をサンプル。パス整合性で棄却サンプリング。
  sampleWorld(state) {
    const n = this.cfg.numPlayers;
    const pool = this._unknownPool(state);
    let last = null;
    for (let attempt = 0; attempt < MAX_SAMPLE_TRIES; attempt++) {
      shuffle(pool);
      const hands = {};
      let idx = 0;
      for (let p = 0; p < n; p++) {
        if (p === this.me) { hands[p] = [...state.hands[this.me]]; continue; }
        const c = state.hands[p].length;
        hands[p] = pool.slice(idx, idx + c);
        idx += c;
      }
      last = hands;
      if (this._consistent(hands)) return hands;
      if (Math.random() < SOFT_PASS_ACCEPT) return hands; // 戦略的パスとして許容
    }
    return last; // 枯渇時は最後のサンプルで妥協（無条件分布へ静かに退化させない）
  }

  _consistent(hands) {
    for (const ev of this.passEvents) {
      const cur = classify(ev.meldTiles, this.cfg.maxRank);
      if (cur === null) continue;
      // パス当時の手札 = 現在のサンプル + その後出した牌
      const handThen = hands[ev.player].concat(ev.laterPlays);
      if (canBeat(handThen, cur, this.cfg)) return false; // 上回れたのにパス → 矛盾
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// 高速貪欲ロールアウト方策（全プレイヤー共通・信念更新なし）
// ---------------------------------------------------------------------------
function rolloutMove(state, cfg) {
  const hand = state.hands[state.turn];
  const cur = state.current;
  if (cur === null) {
    // リード: 最弱の役。速度のためサイズ1-3のみ列挙（5枚役はロールアウトでは省略）
    const melds = [
      ...enumerateMelds(hand, cfg, 1),
      ...enumerateMelds(hand, cfg, 2),
      ...enumerateMelds(hand, cfg, 3),
    ];
    let best = null;
    const preferCombo = Math.random() < 0.35;
    for (const m of melds) {
      if (best === null) { best = m; continue; }
      const sizeScore = (x) => (preferCombo ? -x.size : x.size);
      if (sizeScore(m) < sizeScore(best) ||
          (m.size === best.size && compareKeys(m.key, best.key) < 0)) best = m;
    }
    return best;
  }
  // 応手: 8割で最小の上回り役、2割でパス
  if (!canBeat(hand, cur, cfg)) return null;
  if (Math.random() < 0.2) return null;
  let best = null;
  for (const m of enumerateMelds(hand, cfg, cur.size)) {
    if (!beats(m, cur)) continue;
    if (best === null || compareKeys(m.key, best.key) < 0) best = m;
  }
  return best;
}

function playout(state, cfg, maxSteps = 400) {
  let st = state;
  let guard = 0;
  while (!st.isTerminal() && guard++ < maxSteps) {
    st = st.apply(rolloutMove(st, cfg));
  }
  return st;
}

// ---------------------------------------------------------------------------
// 候補手の事前ランク（枝刈り用の軽いヒューリスティック）
// ---------------------------------------------------------------------------
function preRank(move, hand, cfg) {
  if (move === null) return 0.5; // PASS は常に候補に残す
  let s = 0;
  s += move.size * 1.2;                                   // 多く減らせる手を優先
  const strengths = move.tiles.map((t) => tileStrength(t, cfg.maxRank));
  s -= Math.max(...strengths) * 0.05;                     // 強牌の浪費を軽く減点
  const twos = move.tiles.filter((t) => tileRank(t) === 2).length;
  s -= twos * 0.8;                                        // 2 の温存
  return s;
}

// 同値（size, category, key が同一）の役を1つに集約
function dedupe(moves) {
  const seen = new Set();
  const out = [];
  for (const m of moves) {
    if (m === null) { if (!seen.has("PASS")) { seen.add("PASS"); out.push(null); } continue; }
    const k = `${m.size}|${m.category}|${m.key.join(",")}`;
    if (!seen.has(k)) { seen.add(k); out.push(m); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// chooseMove: 候補ごとに belief から世界をサンプルしてロールアウト、期待収支最大を選ぶ
// ---------------------------------------------------------------------------
export function chooseMove(state, me, belief, opts = {}) {
  const cfg = state.cfg;
  const nRollouts = opts.nRollouts ?? 40;
  const maxCandidates = opts.maxCandidates ?? 12;
  const budgetMs = opts.budgetMs ?? 250;   // 時間予算（最低 MIN_WORLDS 世界は評価）
  const MIN_WORLDS = 8;
  const t0 = Date.now();

  let candidates = dedupe(legalMoves(state.hands[me], state.current, cfg));
  if (candidates.length === 0) return { move: null, thought: null };
  if (candidates.length === 1) {
    return { move: candidates[0], thought: { forced: true } };
  }
  candidates.sort((a, b) => preRank(b, state.hands[me], cfg) - preRank(a, state.hands[me], cfg));
  // PASS は常に残す
  const passIdx = candidates.indexOf(null);
  const kept = candidates.slice(0, maxCandidates);
  if (passIdx >= maxCandidates && passIdx !== -1) kept[maxCandidates - 1] = null;
  candidates = kept;

  const stats = candidates.map(() => ({ sum: 0, wins: 0, n: 0 }));
  const WIN_BONUS = 5;

  for (let r = 0; r < nRollouts; r++) {
    if (r >= MIN_WORLDS && Date.now() - t0 > budgetMs) break;
    const world = belief.sampleWorld(state);
    for (let ci = 0; ci < candidates.length; ci++) {
      // サンプル世界で状態を再構成
      const st = state.clone();
      for (let p = 0; p < cfg.numPlayers; p++) {
        if (p !== me) st.hands[p] = [...world[p]];
      }
      let st2;
      try {
        st2 = st.apply(candidates[ci]);
      } catch { continue; }
      const term = playout(st2, cfg);
      const sc = roundScores(term);
      const won = term.finished[0] === me;
      stats[ci].sum += sc[me] + (won ? WIN_BONUS : 0);
      if (won) stats[ci].wins++;
      stats[ci].n++;
    }
  }

  let bestI = 0;
  const ev = stats.map((s, i) => (s.n ? s.sum / s.n : -Infinity));
  for (let i = 1; i < candidates.length; i++) if (ev[i] > ev[bestI]) bestI = i;
  const chosen = candidates[bestI];

  // 「この役が通る確率」= サンプル世界で誰もこの役を上回れない割合（パス条件付き事後）
  let pSurvive = null;
  if (chosen !== null) {
    let blocked = 0, total = 0;
    for (let r = 0; r < 30; r++) {
      const world = belief.sampleWorld(state);
      total++;
      for (let p = 0; p < cfg.numPlayers; p++) {
        if (p === me || !state.hands[p].length) continue;
        if (canBeat(world[p], chosen, cfg)) { blocked++; break; }
      }
    }
    pSurvive = total ? 1 - blocked / total : null;
  }

  const s = stats[bestI];
  const thought = {
    move: chosen === null ? "パス" : meldText(chosen),
    winProb: s.n ? s.wins / s.n : 0,
    evScore: s.n ? s.sum / s.n : 0,
    pSurvive,
    nRollouts: s.n,
    elapsedMs: Date.now() - t0,
    alternatives: candidates
      .map((m, i) => ({ move: m === null ? "パス" : meldText(m), ev: ev[i] }))
      .sort((a, b) => b.ev - a.ev)
      .slice(0, 3),
  };
  return { move: chosen, thought };
}
