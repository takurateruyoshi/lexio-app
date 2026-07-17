// ai.js — ベイズ信念 + モンテカルロ・ロールアウトAI（全席同一の正準モデル θ）
// 方策・枝刈りの定数はすべて θ（model/weights.json, 自己対戦学習が更新）に集約。
// 計算配分は逐次淘汰（successive halving）による統計的割当のみで、
// ゲーム状況に応じた人為的な条件分岐は持たない。
"use strict";

import {
  fullDeck, tileRank, tileSuit, tileStrength, shuffle,
  classify, beats, compareKeys, enumerateMelds, canBeat, legalMoves,
  roundScores, meldText, straightSequences, CAT_FLUSH,
} from "./engine.js";
import { getTheta } from "./model.js";

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
  sampleWorld(state, softPassAccept) {
    const spa = softPassAccept ?? getTheta().softPassAccept;
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
      if (Math.random() < spa) return hands; // 戦略的パスとして許容
    }
    return last; // 枯渇時は最後のサンプルで妥協
  }

  _consistent(hands) {
    for (const ev of this.passEvents) {
      const cur = classify(ev.meldTiles, this.cfg.maxRank);
      if (cur === null) continue;
      const handThen = hands[ev.player].concat(ev.laterPlays);
      if (canBeat(handThen, cur, this.cfg)) return false; // 上回れたのにパス → 矛盾
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// 軽量5枚役検出器: O(手札) で代表的な5枚役を検出（全列挙の代替）。
// ロールアウトの行動空間から5枚役を人為的に除外しないための装置。
// ---------------------------------------------------------------------------
export function findCombos(hand, cfg) {
  if (hand.length < 5 || cfg.maxMeldSize < 5) return [];
  const mr = cfg.maxRank;
  const out = [];
  const byRank = new Map();   // rank -> tiles (弱い順)
  const bySuit = new Map();   // suit -> tiles
  for (const t of hand) {
    const r = tileRank(t), s = tileSuit(t);
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r).push(t);
    if (!bySuit.has(s)) bySuit.set(s, []);
    bySuit.get(s).push(t);
  }
  const weakest = (ts) => [...ts].sort((a, b) => tileStrength(a, mr) - tileStrength(b, mr));
  const tryAdd = (tiles) => {
    const m = classify(tiles, mr);
    if (m !== null) out.push(m);
  };

  // フォーカード + 最弱1枚
  for (const [r, ts] of byRank) {
    if (ts.length === 4) {
      const rest = weakest(hand.filter((t) => tileRank(t) !== r));
      if (rest.length) tryAdd([...ts, rest[0]]);
    }
  }
  // フルハウス（最弱トリプル + 最弱ペア）
  const trips = [...byRank.entries()].filter(([, ts]) => ts.length >= 3)
    .sort((a, b) => tileStrength(a[1][0], mr) - tileStrength(b[1][0], mr));
  if (trips.length) {
    const [tr, tts] = trips[0];
    const pairs = [...byRank.entries()].filter(([r, ts]) => r !== tr && ts.length >= 2)
      .sort((a, b) => tileStrength(a[1][0], mr) - tileStrength(b[1][0], mr));
    if (pairs.length) {
      tryAdd([...weakest(tts).slice(0, 3), ...weakest(pairs[0][1]).slice(0, 2)]);
    }
  }
  // フラッシュ（同スート最弱3枚を固定し、残り2枠を走査。SF化を避けて素のフラッシュも確保）
  for (const [, ts] of bySuit) {
    if (ts.length < 5) continue;
    const w = weakest(ts);
    outer:
    for (let i = 3; i < w.length - 1; i++) {
      for (let j = i + 1; j < w.length; j++) {
        const m = classify([...w.slice(0, 3), w[i], w[j]], mr);
        if (m !== null) {
          out.push(m);
          if (m.category === CAT_FLUSH) break outer;
        }
      }
    }
  }
  // ストレート / ストレートフラッシュ（各シーケンスで最弱牌を1枚ずつ）
  for (const seq of straightSequences(mr)) {
    if (!seq.every((r) => byRank.has(r))) continue;
    const pick = seq.map((r) => weakest(byRank.get(r))[0]);
    tryAdd(pick);
    // 最弱牌が偶然同スート（SF）になった場合、素のストレート変種も試す
    if (new Set(pick.map(tileSuit)).size === 1) {
      for (const r of seq) {
        const ts = weakest(byRank.get(r));
        if (ts.length >= 2) { tryAdd(pick.map((t) => (tileRank(t) === r ? ts[1] : t))); break; }
      }
    }
    for (const [, sts] of bySuit) {                               // SF
      if (sts.length < 5) continue;
      const ranksInSuit = new Set(sts.map(tileRank));
      if (seq.every((r) => ranksInSuit.has(r))) {
        tryAdd(seq.map((r) => sts.find((t) => tileRank(t) === r)));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// ロールアウト方策（全プレイヤー共通・θ駆動・信念更新なし）
// ---------------------------------------------------------------------------
function rolloutMove(state, cfg, th) {
  const hand = state.hands[state.turn];
  const cur = state.current;
  if (cur === null) {
    // リード: 5枚役も含む行動空間から θ の選好で選ぶ
    const combos = findCombos(hand, cfg);
    if (combos.length && Math.random() < th.rFivePref) {
      let best = combos[0];
      for (const m of combos) if (compareKeys(m.key, best.key) < 0) best = m;
      return best;
    }
    const melds = [
      ...enumerateMelds(hand, cfg, 1),
      ...enumerateMelds(hand, cfg, 2),
      ...enumerateMelds(hand, cfg, 3),
    ];
    let best = null;
    const preferCombo = Math.random() < th.rComboPref;
    for (const m of melds) {
      if (best === null) { best = m; continue; }
      const sizeScore = (x) => (preferCombo ? -x.size : x.size);
      if (sizeScore(m) < sizeScore(best) ||
          (m.size === best.size && compareKeys(m.key, best.key) < 0)) best = m;
    }
    return best;
  }
  // 応手: 最小の上回り役 or パス（率は θ）
  if (!canBeat(hand, cur, cfg)) return null;
  if (Math.random() < th.rPass) return null;
  let best = null;
  for (const m of enumerateMelds(hand, cfg, cur.size)) {
    if (!beats(m, cur)) continue;
    if (best === null || compareKeys(m.key, best.key) < 0) best = m;
  }
  return best;
}

function playout(state, cfg, th, maxSteps = 400) {
  let st = state;
  let guard = 0;
  while (!st.isTerminal() && guard++ < maxSteps) {
    st = st.apply(rolloutMove(st, cfg, th));
  }
  return st;
}

// ---------------------------------------------------------------------------
// 候補手の事前ランク（枝刈り順序・θ駆動）
// ---------------------------------------------------------------------------
function preRank(move, cfg, th) {
  if (move === null) return th.wPass;
  let s = 0;
  s += move.size * th.wSize;
  const strengths = move.tiles.map((t) => tileStrength(t, cfg.maxRank));
  s += Math.max(...strengths) * th.wStrength;
  const twos = move.tiles.filter((t) => tileRank(t) === 2).length;
  s += twos * th.wTwos;
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
// chooseMove: 逐次淘汰で総ロールアウト予算を統計的に配分し、期待収支最大の手を選ぶ
// ---------------------------------------------------------------------------
export function chooseMove(state, me, belief, opts = {}) {
  const cfg = state.cfg;
  const th = opts.theta ?? getTheta();
  const totalPlayouts = opts.totalPlayouts ?? 480;  // 固定総予算（状況による増減なし）
  const maxCandidates = opts.maxCandidates ?? 12;
  const budgetMs = opts.budgetMs ?? 250;            // 実時間の安全上限
  const WIN_BONUS = 5;
  const t0 = Date.now();

  let candidates = dedupe(legalMoves(state.hands[me], state.current, cfg));
  if (candidates.length === 0) return { move: null, thought: null };
  if (candidates.length === 1) {
    return { move: candidates[0], thought: { forced: true } };
  }
  candidates.sort((a, b) => preRank(b, cfg, th) - preRank(a, cfg, th));
  const passIdx = candidates.indexOf(null);
  const kept = candidates.slice(0, maxCandidates);
  if (passIdx >= maxCandidates && passIdx !== -1) kept[maxCandidates - 1] = null;
  candidates = kept;

  const stats = candidates.map(() => ({ sum: 0, wins: 0, n: 0 }));

  const evalWorld = (ci) => {
    const world = belief.sampleWorld(state, th.softPassAccept);
    const st = state.clone();
    for (let p = 0; p < cfg.numPlayers; p++) {
      if (p !== me) st.hands[p] = [...world[p]];
    }
    let st2;
    try { st2 = st.apply(candidates[ci]); } catch { return; }
    const term = playout(st2, cfg, th);
    const sc = roundScores(term);
    const won = term.finished[0] === me;
    stats[ci].sum += sc[me] + (won ? WIN_BONUS : 0);
    if (won) stats[ci].wins++;
    stats[ci].n++;
  };

  // 逐次淘汰: 総予算をラウンドで分割し、各ラウンド後に平均EV下位半分を落とす
  let alive = candidates.map((_, i) => i);
  const rounds = Math.max(1, Math.ceil(Math.log2(candidates.length)));
  const perRound = Math.max(1, Math.floor(totalPlayouts / rounds));
  for (let r = 0; r < rounds && alive.length > 1; r++) {
    const per = Math.max(3, Math.floor(perRound / alive.length));
    for (let k = 0; k < per; k++) {
      if (Date.now() - t0 > budgetMs) break;
      for (const ci of alive) evalWorld(ci);
    }
    alive.sort((a, b) => (stats[b].n ? stats[b].sum / stats[b].n : -Infinity)
                       - (stats[a].n ? stats[a].sum / stats[a].n : -Infinity));
    alive = alive.slice(0, Math.max(1, Math.ceil(alive.length / 2)));
    if (Date.now() - t0 > budgetMs) break;
  }

  const ev = stats.map((s) => (s.n ? s.sum / s.n : -Infinity));
  let bestI = alive[0] ?? 0;
  for (const ci of alive) if (ev[ci] > ev[bestI]) bestI = ci;
  const chosen = candidates[bestI];

  // 「この役が通る確率」= サンプル世界で誰もこの役を上回れない割合（パス条件付き事後）
  let pSurvive = null;
  if (chosen !== null) {
    let blocked = 0, total = 0;
    for (let r = 0; r < 30; r++) {
      const world = belief.sampleWorld(state, th.softPassAccept);
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
    nRollouts: stats.reduce((a, x) => a + x.n, 0),
    elapsedMs: Date.now() - t0,
    // 全候補のEV表（記録・創発観測用）
    candidates: candidates.map((m, i) => ({
      move: m === null ? "パス" : meldText(m),
      size: m === null ? 0 : m.size,
      ev: stats[i].n ? stats[i].sum / stats[i].n : null,
      n: stats[i].n,
    })).sort((a, b) => (b.ev ?? -Infinity) - (a.ev ?? -Infinity)),
  };
  return { move: chosen, thought };
}
