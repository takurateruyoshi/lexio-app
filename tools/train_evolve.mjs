// tools/train_evolve.mjs — 二系統学習 + アリーナ選抜
//
//   node tools/train_evolve.mjs [--minutes 20] [--records games] [--imit-weight 2]
//                               [--min-points 200] [--arena-games 300] [--out model/weights.json]
//
// チャンピオン(現行 model/weights.json)を起点に、
//   系統A: 自己対戦EVのみのCEM（従来の train_selfplay と同じ目的関数）
//   系統B: 自己対戦EV + 人間勝者の着手一致率（収集牌譜からの模倣ブレンド）
// を並行に学習し、最後に A・B・チャンピオンの3者アリーナで最も強い θ を
// 次世代チャンピオンとして model/weights.json に書く（勝者を次世代へ繋ぐ）。
// 牌譜が --min-points 未満なら系統Bは自動的にEVのみへフォールバックする。
// （ゲーム固有の条件分岐は導入しない。θ の意味は js/model.js を参照）
"use strict";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../js/engine.js";
import { BeliefState, chooseMove } from "../js/ai.js";
import { DEFAULT_THETA } from "../js/model.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).join(" ").split("--").filter(Boolean)
    .map((s) => { const [k, v] = s.trim().split(/\s+/); return [k, v ?? true]; }));

const MINUTES = parseFloat(args.minutes ?? "20");
const RECORDS_DIR = args.records
  ? (isAbsolute(args.records) ? args.records : join(ROOT, args.records))
  : null;
const IMIT_WEIGHT = parseFloat(args["imit-weight"] ?? "2");
const MIN_POINTS = parseInt(args["min-points"] ?? "200", 10);
const ARENA_GAMES = parseInt(args["arena-games"] ?? "300", 10);
const OUT = join(ROOT, args.out ?? "model/weights.json");
const HISTORY = join(ROOT, "model/history.json");
const OUT_A = join(ROOT, "model/weights_selfplay.json");
const OUT_B = join(ROOT, "model/weights_human.json");

// ---- CEM 定数（train_selfplay.mjs と同一） ----
const PARAM_KEYS = ["wSize", "wStrength", "wTwos", "wPass",
                    "rPass", "rComboPref", "rFivePref", "softPassAccept"];
const SIGMA0 = { wSize: 0.4, wStrength: 0.04, wTwos: 0.4, wPass: 0.3,
                 rPass: 0.1, rComboPref: 0.15, rFivePref: 0.15, softPassAccept: 0.1 };
const CLAMP = { rPass: [0, 0.9], rComboPref: [0, 1], rFivePref: [0, 1],
                softPassAccept: [0.02, 0.8] };
const CHOOSE_OPTS = { totalPlayouts: 90, budgetMs: 60, maxCandidates: 8 };
const IMIT_OPTS = { totalPlayouts: 40, budgetMs: 30, maxCandidates: 8 };
const POP = 8;
const ELITE = 3;
const GAMES_PER_EVAL = 18;
const IMIT_SAMPLE = 80;      // 世代毎に評価する決定点数（同世代の全個体で共通）

function loadTheta() {
  try { return { ...DEFAULT_THETA, ...JSON.parse(readFileSync(OUT, "utf8")) }; }
  catch { return { ...DEFAULT_THETA }; }
}
function clampTheta(t) {
  for (const [k, [lo, hi]] of Object.entries(CLAMP)) t[k] = Math.min(hi, Math.max(lo, t[k]));
  return t;
}
function perturb(base, sigma) {
  const t = { ...base };
  for (const k of PARAM_KEYS) t[k] = base[k] + sigma[k] * (Math.random() * 2 - 1) * 1.5;
  return clampTheta(t);
}

function playGame(nPlayers, thetas) {
  const cfg = E.standardConfig(nPlayers);
  let st = E.GameState.deal(cfg);
  const beliefs = [];
  for (let p = 0; p < nPlayers; p++) beliefs.push(new BeliefState(cfg, p, st.hands[p]));
  let guard = 0;
  while (!st.isTerminal() && guard++ < 400) {
    const me = st.turn;
    beliefs[me].syncMyHand(st.hands[me]);
    const { move } = chooseMove(st, me, beliefs[me], { ...CHOOSE_OPTS, theta: thetas[me] });
    const curTiles = st.current ? st.current.tiles : null;
    for (let p = 0; p < nPlayers; p++) {
      if (move === null) beliefs[p].observePass(me, curTiles);
      else beliefs[p].observePlay(me, move.tiles);
    }
    st = st.apply(move);
  }
  return E.roundScores(st);
}

function evaluate(cand, base, games, counter) {
  let sum = 0, n = 0;
  const sizes = [2, 3, 5];
  for (let g = 0; g < games; g++) {
    const np = sizes[g % sizes.length];
    const seat = g % np;
    const thetas = Array.from({ length: np }, () => base);
    thetas[seat] = cand;
    const sc = playGame(np, thetas);
    sum += sc[seat]; n++;
    counter.games++;
  }
  return sum / n;
}

// ---- 牌譜のロード / 検証 -------------------------------------------------

function* walkJsonl(dir) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkJsonl(p);
    else if (e.endsWith(".jsonl") || e.endsWith(".json")) yield p;
  }
}

function stateFromDeal(cfg, deal) {
  const st = new E.GameState(cfg);
  st.hands = deal.map((h) => [...h].sort((a, b) => a - b));
  const dealt = new Set(deal.flat());
  st.hidden = E.fullDeck(cfg).filter((t) => !dealt.has(t));
  st.leader = E.startingPlayer(st.hands);
  st.turn = st.leader;
  st.passed = new Array(cfg.numPlayers).fill(false);
  st.played = Array.from({ length: cfg.numPlayers }, () => []);
  st.finished = [];
  return st;
}

// 1レコードをエンジンでリプレイして整合性を検証。矛盾があれば null。
function validateRecord(rec) {
  const np = rec.numPlayers;
  if (!Number.isInteger(np) || np < 2 || np > 5) return null;
  if (rec.mode === "tutorial") return null;
  if (!Array.isArray(rec.deal) || rec.deal.length !== np) return null;
  if (!Array.isArray(rec.moves) || !rec.moves.length) return null;
  if (!Array.isArray(rec.scores) || !Array.isArray(rec.finished)) return null;
  if (Array.isArray(rec.cardMods) && rec.cardMods.length) return null;   // Neoカード介入は除外
  const cfg = E.standardConfig(np);
  for (const h of rec.deal) {
    if (!Array.isArray(h) || h.length !== cfg.handSize) return null;
  }
  for (const m of rec.moves) {
    if (m.tiles && m.tiles.some((t) => t >= 1000)) return null;          // ジョーカー仮想牌は除外
  }
  try {
    let st = stateFromDeal(cfg, rec.deal);
    for (const m of rec.moves) {
      if (st.isTerminal()) return null;
      if (st.turn !== m.seat) return null;
      if (m.tiles === null || m.tiles === undefined) { st = st.apply(null); continue; }
      const meld = E.classify(m.tiles, cfg.maxRank);
      if (!meld) return null;
      st = st.apply(meld);
    }
    return rec;
  } catch { return null; }
}

function loadRecords(dir) {
  const seen = new Set();
  const records = [];
  let raw = 0, dup = 0, invalid = 0;
  for (const file of walkJsonl(dir)) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let rec;
      try { rec = JSON.parse(s); } catch { continue; }
      // 1ファイル=JSON配列（HTTP収集形式）にも対応
      const list = Array.isArray(rec) ? rec : [rec];
      for (const r of list) {
        raw++;
        const key = `${r.at}|${JSON.stringify(r.deal)}`;
        if (seen.has(key)) { dup++; continue; }
        seen.add(key);
        if (validateRecord(r)) records.push(r);
        else invalid++;
      }
    }
  }
  console.log(`records: raw=${raw} dup=${dup} invalid=${invalid} valid=${records.length}`);
  return records;
}

// 決定点: 「勝った人間（human/remote）」の着手のみを教師にする
function decisionPoints(records) {
  const pts = [];
  records.forEach((rec, ri) => {
    rec.moves.forEach((m, mi) => {
      const seat = rec.seats?.[m.seat];
      if (!seat) return;
      if (seat.kind !== "human" && seat.kind !== "remote") return;
      if (!(rec.scores[m.seat] > 0)) return;
      pts.push({ ri, mi });
    });
  });
  return pts;
}

// 候補θの「人間勝者の着手との一致率」。sample は {ri, mi} の配列（同世代で共通）。
function imitationRate(cand, records, sample) {
  if (!sample.length) return 0;
  const byRec = new Map();
  for (const p of sample) {
    if (!byRec.has(p.ri)) byRec.set(p.ri, new Set());
    byRec.get(p.ri).add(p.mi);
  }
  let hit = 0, n = 0;
  for (const [ri, mis] of byRec) {
    const rec = records[ri];
    const cfg = E.standardConfig(rec.numPlayers);
    let st = stateFromDeal(cfg, rec.deal);
    const beliefs = [];
    for (let p = 0; p < rec.numPlayers; p++) beliefs.push(new BeliefState(cfg, p, st.hands[p]));
    for (let mi = 0; mi < rec.moves.length; mi++) {
      const m = rec.moves[mi];
      if (mis.has(mi)) {
        beliefs[m.seat].syncMyHand(st.hands[m.seat]);
        const { move } = chooseMove(st, m.seat, beliefs[m.seat], { ...IMIT_OPTS, theta: cand });
        const actual = m.tiles ? [...m.tiles].sort((a, b) => a - b).join(",") : null;
        const chosen = move ? [...move.tiles].sort((a, b) => a - b).join(",") : null;
        if (actual === chosen) hit++;
        n++;
      }
      const curTiles = st.current ? st.current.tiles : null;
      const meld = m.tiles ? E.classify(m.tiles, cfg.maxRank) : null;
      for (let p = 0; p < rec.numPlayers; p++) {
        if (meld === null) beliefs[p].observePass(m.seat, curTiles);
        else beliefs[p].observePlay(m.seat, meld.tiles);
      }
      st = st.apply(meld);
      if (st.isTerminal()) break;
    }
  }
  return n ? hit / n : 0;
}

function sampleArray(arr, k) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

// ---- CEM 1系統 ------------------------------------------------------------
function cemRun(label, start, deadline, counter, imitCtx) {
  let theta = { ...start };
  const sigma = { ...SIGMA0 };
  let gens = 0;
  let lastImit = null;
  while (Date.now() < deadline) {
    const pop = [theta, ...Array.from({ length: POP - 1 }, () => perturb(theta, sigma))];
    const sample = imitCtx ? sampleArray(imitCtx.points, IMIT_SAMPLE) : null;
    const scored = pop.map((t) => {
      const ev = evaluate(t, theta, GAMES_PER_EVAL, counter);
      let fit = ev, imit = null;
      if (imitCtx) {
        imit = imitationRate(t, imitCtx.records, sample);
        fit = ev + IMIT_WEIGHT * imit;
      }
      return { t, fit, ev, imit };
    });
    scored.sort((a, b) => b.fit - a.fit);
    const elites = scored.slice(0, ELITE).map((s) => s.t);
    const next = { ...theta };
    for (const k of PARAM_KEYS) next[k] = elites.reduce((a, t) => a + t[k], 0) / elites.length;
    theta = clampTheta(next);
    for (const k of PARAM_KEYS) sigma[k] *= 0.93;
    gens++;
    lastImit = scored[0].imit;
    console.log(`[${label}] gen +${gens}: fit(top)=${scored[0].fit.toFixed(2)}` +
      (imitCtx ? ` ev=${scored[0].ev.toFixed(2)} imit=${(scored[0].imit * 100).toFixed(0)}%` : "") +
      " " + PARAM_KEYS.map((k) => `${k}=${theta[k].toFixed(2)}`).join(" "));
  }
  return { theta, gens, lastImit };
}

// ---- アリーナ: 3者総当たり（席を巡回） -------------------------------------
function arena(cands, games, counter) {
  const sums = cands.map(() => 0);
  const ns = cands.map(() => 0);
  const sizes = [2, 3, 5];
  for (let g = 0; g < games; g++) {
    const np = sizes[g % sizes.length];
    const assign = [];   // 各席の候補index（巡回で公平化）
    for (let s = 0; s < np; s++) assign.push((g + s) % cands.length);
    const thetas = assign.map((ci) => cands[ci].theta);
    const sc = playGame(np, thetas);
    for (let s = 0; s < np; s++) { sums[assign[s]] += sc[s]; ns[assign[s]]++; }
    counter.games++;
  }
  return cands.map((c, i) => ({ ...c, mean: ns[i] ? sums[i] / ns[i] : 0, games: ns[i] }));
}

// ---- メイン ----------------------------------------------------------------
const t0 = Date.now();
const totalMs = MINUTES * 60 * 1000;
const counter = { games: 0 };
const champion = loadTheta();

console.log(`train_evolve: start champion gen=${champion.gen ?? 0} games=${champion.games ?? 0} budget=${MINUTES}min`);

// 牌譜ロード（無ければ純自己対戦のみの2系統）
let records = [], points = [];
if (RECORDS_DIR) {
  records = loadRecords(RECORDS_DIR);
  points = decisionPoints(records);
}
const useImit = points.length >= MIN_POINTS;
console.log(`imitation: points=${points.length} (min ${MIN_POINTS}) -> ${useImit ? `ON (weight ${IMIT_WEIGHT})` : "OFF (self-play only)"}`);

// 学習時間配分: 系統A 35% / 系統B 35% / アリーナ 30%
const tA = t0 + totalMs * 0.35;
const tB = t0 + totalMs * 0.70;
const resA = cemRun("selfplay", champion, tA, counter, null);
const resB = cemRun("human", champion, tB, counter,
                    useImit ? { records, points } : null);

// ---- アリーナ選抜 ----
const ranked = arena([
  { name: "champion", theta: champion, gens: 0 },
  { name: "selfplay", theta: resA.theta, gens: resA.gens },
  { name: "human", theta: resB.theta, gens: resB.gens },
], ARENA_GAMES, counter);
for (const r of ranked) console.log(`arena: ${r.name} mean=${r.mean.toFixed(3)} (${r.games} seats)`);

const winner = ranked.reduce((a, b) => (b.mean > a.mean ? b : a));
const champEntry = ranked.find((r) => r.name === "champion");
const promote = winner.name !== "champion" && winner.mean >= champEntry.mean && winner.gens > 0;
console.log(`winner: ${winner.name} -> ${promote ? "PROMOTE" : "KEEP champion"}`);

// ---- 出力 ----
const now = new Date().toISOString();
function stamp(theta, lineage, gens) {
  const t = { ...theta };
  t.v = champion.v || 1;
  t.gen = (champion.gen || 0) + gens;
  t.games = (champion.games || 0) + counter.games;
  t.lineage = lineage;
  t.updatedAt = now;
  return t;
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT_A, JSON.stringify(stamp(resA.theta, "selfplay", resA.gens), null, 2));
writeFileSync(OUT_B, JSON.stringify(stamp(resB.theta, useImit ? "human" : "selfplay-fallback", resB.gens), null, 2));

if (promote) {
  const t = stamp(winner.theta, winner.name, winner.gens);
  delete t.lineage;   // 配信θは従来スキーマを維持（lineageはhistoryに残す）
  writeFileSync(OUT, JSON.stringify(t, null, 2));
  console.log(`written: ${OUT} (gen=${t.gen}, games=${t.games}, from=${winner.name})`);
}

let hist = [];
try { hist = JSON.parse(readFileSync(HISTORY, "utf8")); } catch {}
hist.push({
  at: now,
  kind: "evolve",
  champion: promote ? winner.name : "champion",
  arena: Object.fromEntries(ranked.map((r) => [r.name, +r.mean.toFixed(3)])),
  arenaGames: ARENA_GAMES,
  imitPoints: points.length,
  imitOn: useImit,
  imitRate: resB.lastImit == null ? null : +resB.lastImit.toFixed(3),
  records: records.length,
  gens: { selfplay: resA.gens, human: resB.gens },
  gamesPlayed: counter.games,
});
writeFileSync(HISTORY, JSON.stringify(hist.slice(-200), null, 2));
console.log(promote ? "champion updated" : "champion kept (candidates saved to weights_*.json)");
