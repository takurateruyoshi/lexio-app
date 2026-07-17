// tools/train_selfplay.mjs — 正準モデル θ の継続学習（クロスエントロピー法 / 自己対戦）
//
//   node tools/train_selfplay.mjs [--minutes 20] [--out model/weights.json]
//
// 現行 model/weights.json を開始点に、θ+ノイズの候補集団で自己対戦リーグを行い
// 上位平均で θ を更新。最後に現行モデルとのゲート対戦を行い、
// 平均収支が劣らない場合のみ weights.json / history.json を更新する。
// （ゲーム固有の条件分岐は一切導入しない。θ の意味は js/model.js を参照）
"use strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../js/engine.js";
import { BeliefState, chooseMove } from "../js/ai.js";
import { DEFAULT_THETA } from "../js/model.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).join(" ").split("--").filter(Boolean)
    .map((s) => { const [k, v] = s.trim().split(/\s+/); return [k, v ?? true]; }));

const MINUTES = parseFloat(args.minutes ?? "10");
const OUT = join(ROOT, args.out ?? "model/weights.json");
const HISTORY = join(ROOT, "model/history.json");

// 学習対象パラメタとノイズ幅（探索スケール）
const PARAM_KEYS = ["wSize", "wStrength", "wTwos", "wPass",
                    "rPass", "rComboPref", "rFivePref", "softPassAccept"];
const SIGMA0 = { wSize: 0.4, wStrength: 0.04, wTwos: 0.4, wPass: 0.3,
                 rPass: 0.1, rComboPref: 0.15, rFivePref: 0.15, softPassAccept: 0.1 };
const CLAMP = { rPass: [0, 0.9], rComboPref: [0, 1], rFivePref: [0, 1],
                softPassAccept: [0.02, 0.8] };

// 学習時の探索予算（全候補共通・小さめで高速化。対局条件は全個体で同一）
const CHOOSE_OPTS = { totalPlayouts: 90, budgetMs: 60, maxCandidates: 8 };

const POP = 8;        // 集団サイズ
const ELITE = 3;      // 上位採用数
const GAMES_PER_EVAL = 18;   // 個体評価の対局数（2/3/5人戦を巡回）
const GATE_GAMES = 150;      // ゲート対戦数

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
  for (const k of PARAM_KEYS) {
    t[k] = base[k] + sigma[k] * (Math.random() * 2 - 1) * 1.5;
  }
  return clampTheta(t);
}

// thetas[seat] で1局。各席の収支を返す。
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

// 候補θ vs 基準θ: 候補を1席に置き（席は巡回）、平均収支を返す
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

// ---- メイン ----
const t0 = Date.now();
const deadline = t0 + MINUTES * 60 * 1000;
let theta = loadTheta();
const startTheta = { ...theta };
const sigma = { ...SIGMA0 };
const counter = { games: 0 };
let gens = 0;

console.log(`train_selfplay: start gen=${theta.gen} games=${theta.games} budget=${MINUTES}min`);

while (Date.now() < deadline - 60 * 1000) {   // ゲート対戦分の余裕を残す
  const pop = [theta, ...Array.from({ length: POP - 1 }, () => perturb(theta, sigma))];
  const scored = pop.map((t) => ({ t, fit: evaluate(t, theta, GAMES_PER_EVAL, counter) }));
  scored.sort((a, b) => b.fit - a.fit);
  const elites = scored.slice(0, ELITE).map((s) => s.t);
  const next = { ...theta };
  for (const k of PARAM_KEYS) {
    next[k] = elites.reduce((a, t) => a + t[k], 0) / elites.length;
  }
  theta = clampTheta(next);
  for (const k of PARAM_KEYS) sigma[k] *= 0.93;   // 探索半径を減衰
  gens++;
  console.log(`gen +${gens}: fit(top)=${scored[0].fit.toFixed(2)} ` +
    PARAM_KEYS.map((k) => `${k}=${theta[k].toFixed(2)}`).join(" "));
}

// ---- ゲート: 新θ vs 現行θ（開始点） ----
let gateSum = 0, gateN = 0;
const sizes = [2, 3, 5];
for (let g = 0; g < GATE_GAMES; g++) {
  const np = sizes[g % sizes.length];
  const seat = g % np;
  const thetas = Array.from({ length: np }, () => startTheta);
  thetas[seat] = theta;
  const sc = playGame(np, thetas);
  gateSum += sc[seat]; gateN++;
  counter.games++;
}
const gateMean = gateSum / gateN;
const pass = gateMean >= 0;
console.log(`gate: mean=${gateMean.toFixed(3)} over ${gateN} games -> ${pass ? "UPDATE" : "KEEP"}`);

if (pass && gens > 0) {
  theta.v = (startTheta.v || 1);
  theta.gen = (startTheta.gen || 0) + gens;
  theta.games = (startTheta.games || 0) + counter.games;
  theta.updatedAt = new Date().toISOString();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(theta, null, 2));
  let hist = [];
  try { hist = JSON.parse(readFileSync(HISTORY, "utf8")); } catch {}
  hist.push({ at: theta.updatedAt, gen: theta.gen, games: theta.games,
              gateMean: +gateMean.toFixed(3), gens,
              theta: Object.fromEntries(PARAM_KEYS.map((k) => [k, +theta[k].toFixed(4)])) });
  writeFileSync(HISTORY, JSON.stringify(hist.slice(-200), null, 2));
  console.log(`written: ${OUT} (gen=${theta.gen}, games=${theta.games})`);
} else {
  console.log("no update");
}
