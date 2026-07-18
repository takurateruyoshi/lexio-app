// engine.js — レキシオのルールエンジン（game_cfr_agent.py の1:1移植）
// 牌 = 整数 ID = rank*4 + suit (rank:1..maxRank, suit:0..3)
"use strict";

export const PLAYER_CONFIG = { 2: [9, 12], 3: [9, 12], 4: [13, 13], 5: [15, 12] };

export const SUIT_CLASS = ["cloud", "star", "moon", "sun"];
export const SUIT_LABEL = ["雲", "星", "月", "太陽"];
export const SUIT_GLYPH = ["☁", "★", "☾", "☀"];

export function standardConfig(numPlayers, maxMeldSize = 5) {
  const [mr, hs] = PLAYER_CONFIG[numPlayers];
  return { numPlayers, maxRank: mr, handSize: hs, maxMeldSize };
}

// ---- 牌と強さ ----------------------------------------------------------
// 通常牌: id = rank*4 + suit。Neoのジョーカー仮想牌: id = 1000 + rank*4 + suit
// （rank/suit の算出で 1000 を剰余で落とすことで、役判定・強さ比較は透過的に動く）
export const makeTile = (rank, suit) => rank * 4 + suit;
export const tileRank = (t) => Math.floor((t % 1000) / 4);
export const tileSuit = (t) => (t % 1000) % 4;

// 数字の強さ順位: 3<4<...<max<1<2
export function rankStrength(rank, maxRank) {
  if (rank >= 3) return rank - 3;
  if (rank === 1) return maxRank - 2;
  return maxRank - 1; // rank === 2
}

export const tileStrength = (t, maxRank) =>
  rankStrength(tileRank(t), maxRank) * 4 + tileSuit(t);

export const tileStr = (t) => SUIT_GLYPH[tileSuit(t)] + tileRank(t);

export function fullDeck(cfg) {
  const deck = [];
  for (let r = 1; r <= cfg.maxRank; r++)
    for (let s = 0; s < 4; s++) deck.push(makeTile(r, s));
  return deck;
}

export function shuffle(arr, rand = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- 役 (Meld) ----------------------------------------------------------
export const CAT_STRAIGHT = 0;
export const CAT_FLUSH = 1;
export const CAT_FULLHOUSE = 2;
export const CAT_FOURPLUS = 3;
export const CAT_STRAIGHTFLUSH = 4;

// key は数値配列。辞書式比較。
export function compareKeys(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
}

export function straightSequences(maxRank) {
  const seqs = [];
  // 自然な連番 a..a+4（1-2-3-4-5 や 2-3-4-5-6 を含む）
  for (let a = 1; a <= maxRank - 4; a++) seqs.push([a, a + 1, a + 2, a + 3, a + 4]);
  // 上端ラップは「1 で終わる」形のみ（例: 6-7-8-9-1）。2 を最後に置くことはできない。
  seqs.push([maxRank - 3, maxRank - 2, maxRank - 1, maxRank, 1]);
  return seqs;
}

function seqStrengthKey(ranks, maxRank) {
  return ranks.map((r) => rankStrength(r, maxRank)).sort((x, y) => y - x);
}

const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// 牌集合が正当な役なら {tiles,size,category,key} を返す。不正なら null。
export function classify(tiles, maxRank) {
  const ts = [...tiles].sort((a, b) => a - b);
  const n = ts.length;
  const ranks = ts.map(tileRank);
  const suits = ts.map(tileSuit);
  const rc = new Map();
  for (const r of ranks) rc.set(r, (rc.get(r) || 0) + 1);

  if (n === 1) return { tiles: ts, size: 1, category: -1, key: [tileStrength(ts[0], maxRank)] };
  if (n === 2) {
    if (ranks[0] !== ranks[1]) return null;
    let strongest = ts[0];
    for (const t of ts) if (tileStrength(t, maxRank) > tileStrength(strongest, maxRank)) strongest = t;
    return { tiles: ts, size: 2, category: -1, key: [rankStrength(ranks[0], maxRank), tileSuit(strongest)] };
  }
  if (n === 3) {
    if (rc.size !== 1) return null;
    return { tiles: ts, size: 3, category: -1, key: [rankStrength(ranks[0], maxRank)] };
  }
  if (n === 5) {
    const validSeqs = straightSequences(maxRank);
    const rankset = [...new Set(ranks)].sort((a, b) => a - b);
    let seqFor = null;
    if (rc.size === 5) {
      for (const s of validSeqs) {
        if (sameSet([...s].sort((a, b) => a - b), rankset)) { seqFor = s; break; }
      }
    }
    const isStraight = seqFor !== null;
    const isFlush = new Set(suits).size === 1;

    if (isStraight && isFlush) {
      return { tiles: ts, size: 5, category: CAT_STRAIGHTFLUSH,
               key: [CAT_STRAIGHTFLUSH, ...seqStrengthKey(seqFor, maxRank), suits[0]] };
    }
    const counts = [...rc.values()].sort((a, b) => b - a);
    if (counts.length === 2 && counts[0] === 4) {
      const quadRank = [...rc.entries()].find(([, c]) => c === 4)[0];
      return { tiles: ts, size: 5, category: CAT_FOURPLUS,
               key: [CAT_FOURPLUS, rankStrength(quadRank, maxRank)] };
    }
    if (counts.length === 2 && counts[0] === 3) {
      const tripRank = [...rc.entries()].find(([, c]) => c === 3)[0];
      return { tiles: ts, size: 5, category: CAT_FULLHOUSE,
               key: [CAT_FULLHOUSE, rankStrength(tripRank, maxRank)] };
    }
    if (isFlush) {
      const key = [CAT_FLUSH, ...ts.map((t) => tileStrength(t, maxRank)).sort((x, y) => y - x)];
      return { tiles: ts, size: 5, category: CAT_FLUSH, key };
    }
    if (isStraight) {
      let topRank = seqFor[0];
      for (const r of seqFor) if (rankStrength(r, maxRank) > rankStrength(topRank, maxRank)) topRank = r;
      let topSuit = -1;
      for (const t of ts) if (tileRank(t) === topRank) topSuit = Math.max(topSuit, tileSuit(t));
      return { tiles: ts, size: 5, category: CAT_STRAIGHT,
               key: [CAT_STRAIGHT, ...seqStrengthKey(seqFor, maxRank), topSuit] };
    }
    return null;
  }
  return null;
}

// cand が current より強い(出せる)か。current=null はリード(自由)。
export function beats(cand, current) {
  if (current === null || current === undefined) return true;
  if (cand.size !== current.size) return false;
  return compareKeys(cand.key, current.key) > 0;
}

// ---- 合法手の生成 --------------------------------------------------------
function* combosOfSize(tiles, size) {
  const arr = [...tiles].sort((a, b) => a - b);
  const n = arr.length;
  if (size > n) return;
  const idx = Array.from({ length: size }, (_, i) => i);
  while (true) {
    yield idx.map((i) => arr[i]);
    let i = size - 1;
    while (i >= 0 && idx[i] === i + n - size) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < size; j++) idx[j] = idx[j - 1] + 1;
  }
}

export function enumerateMelds(hand, cfg, size = null) {
  const melds = [];
  const sizes = size !== null ? [size] : [1, 2, 3, 5];
  for (const sz of sizes) {
    if (sz > cfg.maxMeldSize || sz > hand.length) continue;
    for (const c of combosOfSize(hand, sz)) {
      const m = classify(c, cfg.maxRank);
      if (m !== null) melds.push(m);
    }
  }
  return melds;
}

// hand が current を上回る役を1つでも作れるか（高速判定）
export function canBeat(hand, current, cfg) {
  const mr = cfg.maxRank;
  const sz = current.size;
  if (sz === 1) {
    const thr = current.key[0];
    return hand.some((t) => tileStrength(t, mr) > thr);
  }
  if (sz === 2) {
    const rc = new Map();
    for (const t of hand) {
      if (!rc.has(tileRank(t))) rc.set(tileRank(t), []);
      rc.get(tileRank(t)).push(t);
    }
    for (const [r, ts] of rc) {
      if (ts.length >= 2) {
        const strongest = Math.max(...ts.map(tileSuit));
        if (compareKeys([rankStrength(r, mr), strongest], current.key) > 0) return true;
      }
    }
    return false;
  }
  if (sz === 3) {
    const rc = new Map();
    for (const t of hand) rc.set(tileRank(t), (rc.get(tileRank(t)) || 0) + 1);
    for (const [r, c] of rc) {
      if (c >= 3 && compareKeys([rankStrength(r, mr)], current.key) > 0) return true;
    }
    return false;
  }
  if (sz > cfg.maxMeldSize) return false;
  for (const c of combosOfSize(hand, 5)) {
    const m = classify(c, mr);
    if (m !== null && compareKeys(m.key, current.key) > 0) return true;
  }
  return false;
}

// current に対して出せる役 + パス(null)。リード時はパス不可。
export function legalMoves(hand, current, cfg) {
  if (current === null || current === undefined) return enumerateMelds(hand, cfg);
  const moves = [null];
  for (const m of enumerateMelds(hand, cfg, current.size)) {
    if (beats(m, current)) moves.push(m);
  }
  return moves;
}

// ---- 盤面管理 ------------------------------------------------------------
export function startingPlayer(hands) {
  const target = makeTile(3, 0); // 雲の3
  for (let i = 0; i < hands.length; i++) if (hands[i].includes(target)) return i;
  let bestI = 0, bestV = Infinity;
  for (let i = 0; i < hands.length; i++) {
    const v = Math.min(...hands[i].map((t) => tileRank(t) * 4 + tileSuit(t)));
    if (v < bestV) { bestI = i; bestV = v; }
  }
  return bestI;
}

export class GameState {
  constructor(cfg) {
    this.cfg = cfg;
    this.hands = [];
    this.hidden = [];
    this.current = null;       // 場の役
    this.leader = 0;
    this.turn = 0;
    this.passed = [];
    this.lastPlayer = -1;
    this.played = [];          // 各人の出した役の履歴
    this.finished = [];        // 上がり順
  }

  static deal(cfg, rand = Math.random) {
    const st = new GameState(cfg);
    const deck = shuffle(fullDeck(cfg), rand);
    st.hands = [];
    for (let i = 0; i < cfg.numPlayers; i++) {
      st.hands.push(deck.slice(i * cfg.handSize, (i + 1) * cfg.handSize).sort((a, b) => a - b));
    }
    st.hidden = deck.slice(cfg.numPlayers * cfg.handSize);
    st.leader = startingPlayer(st.hands);
    st.turn = st.leader;
    st.passed = new Array(cfg.numPlayers).fill(false);
    st.played = Array.from({ length: cfg.numPlayers }, () => []);
    st.finished = [];
    return st;
  }

  // リロード復帰用のシリアライズ
  toJSON() {
    return {
      hands: this.hands.map((h) => [...h]),
      hidden: [...this.hidden],
      current: this.current ? [...this.current.tiles] : null,
      leader: this.leader,
      turn: this.turn,
      passed: [...this.passed],
      lastPlayer: this.lastPlayer,
      played: this.played.map((ms) => ms.map((m) => [...m.tiles])),
      finished: [...this.finished],
    };
  }

  static fromJSON(cfg, d) {
    const st = new GameState(cfg);
    st.hands = d.hands.map((h) => [...h]);
    st.hidden = [...d.hidden];
    st.current = d.current ? classify(d.current, cfg.maxRank) : null;
    st.leader = d.leader;
    st.turn = d.turn;
    st.passed = [...d.passed];
    st.lastPlayer = d.lastPlayer;
    st.played = (d.played || []).map((ms) => ms.map((ts) => classify(ts, cfg.maxRank)));
    st.finished = [...d.finished];
    return st;
  }

  activePlayers() {
    const out = [];
    for (let i = 0; i < this.cfg.numPlayers; i++) if (this.hands[i].length) out.push(i);
    return out;
  }

  // 誰かが上がった時点でラウンド終了（即精算）
  isTerminal() { return this.finished.length >= 1 || this.activePlayers().length <= 1; }

  clone() {
    const s = new GameState(this.cfg);
    s.hands = this.hands.map((h) => [...h]);
    s.hidden = [...this.hidden];
    s.current = this.current;
    s.leader = this.leader;
    s.turn = this.turn;
    s.passed = [...this.passed];
    s.lastPlayer = this.lastPlayer;
    s.played = this.played.map((p) => [...p]);
    s.finished = [...this.finished];
    return s;
  }

  _advanceTurn() {
    const n = this.cfg.numPlayers;
    for (let step = 1; step <= n; step++) {
      const nxt = (this.turn + step) % n;
      if (this.hands[nxt].length && !this.passed[nxt]) { this.turn = nxt; return; }
    }
    this.turn = this.leader; // 保険
  }

  _resetTrick() {
    this.current = null;
    this.leader = this.lastPlayer >= 0 ? this.lastPlayer : this.turn;
    this.passed = new Array(this.cfg.numPlayers).fill(false);
    for (let i = 0; i < this.cfg.numPlayers; i++) {
      if (!this.hands[i].length) this.passed[i] = true;
    }
    this.turn = this.leader;
    if (!this.hands[this.turn].length) this._advanceTurn();
  }

  // move: Meld または null(パス)。非破壊。
  apply(move) {
    const s = this.clone();
    const p = s.turn;
    if (move === null || move === undefined) {
      s.passed[p] = true;
    } else {
      for (const t of move.tiles) {
        if (t >= 1000) continue;   // ジョーカー仮想牌は手牌に存在しない
        const i = s.hands[p].indexOf(t);
        if (i < 0) throw new Error(`tile ${t} not in hand of P${p}`);
        s.hands[p].splice(i, 1);
      }
      s.current = move;
      s.lastPlayer = p;
      s.played[p].push(move);
      // パスは「その時点の役への保留」— 新しい役が出たら全員のパスを解除する
      for (let i = 0; i < s.cfg.numPlayers; i++) s.passed[i] = !s.hands[i].length;
      if (!s.hands[p].length) {            // 上がり
        s.finished.push(p);
        s.passed[p] = true;
      }
    }
    // 場の決着判定: リード以外の全生存者がパス -> リセット
    const live = [];
    for (let i = 0; i < s.cfg.numPlayers; i++) if (s.hands[i].length) live.push(i);
    const nonPassed = live.filter((i) => !s.passed[i]);
    if (s.current !== null && nonPassed.length <= 1) {
      if (s.hands[s.lastPlayer].length) {
        s._resetTrick();
      } else {
        // 場を制した人が上がってしまった場合, 次の生存者がリード
        s.current = null;
        s.passed = new Array(s.cfg.numPlayers).fill(false);
        for (let i = 0; i < s.cfg.numPlayers; i++) {
          if (!s.hands[i].length) s.passed[i] = true;
        }
        s.leader = s.lastPlayer;
        s.turn = s.lastPlayer;
        s._advanceTurn();
        s.leader = s.turn;
      }
    } else {
      s._advanceTurn();
    }
    return s;
  }
}

// ---- 得点計算 --------------------------------------------------------------
// ペアワイズ: 残り枚数の差を、多い側がその人の倍率(2^手中の2の枚数: ×2,×4,…)で支払う。
export function roundScores(state) {
  const n = state.cfg.numPlayers;
  const remain = state.hands.map((h) => h.length);
  const mult = state.hands.map((h) => Math.pow(2, h.filter((t) => tileRank(t) === 2).length));
  const score = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (remain[i] > remain[j]) {
        const pay = (remain[i] - remain[j]) * mult[i];
        score[i] -= pay;
        score[j] += pay;
      }
    }
  }
  return score;
}

export function meldText(m) {
  return m.tiles.map(tileStr).join(" ");
}
