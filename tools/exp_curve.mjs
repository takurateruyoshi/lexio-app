// tools/exp_curve.mjs — 阻害率の世代カーブ + 判別実験
//
//   node tools/exp_curve.mjs --thetas <file.json> [--games 100] --out <result.json>
//
// thetas: [{gen, theta}] の配列（gen0のDEFAULT_THETAは自動で先頭に追加）。
// 各θで全席同一の自己対戦を行い、
//   blockRate     : 脅威(残1-2枚)がいるリード手番での阻害率
//   bigThreat     : 脅威ありリードでの多枚(≥2)リード率
//   bigNoThreat   : 脅威なしリードでの多枚(≥2)リード率（「大役好き」の対照条件）
// を計測する。標的がいる時だけ多枚リードが増えるなら「標的依存の行動変化」。
"use strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../js/engine.js";
import { BeliefState, chooseMove } from "../js/ai.js";
import { DEFAULT_THETA } from "../js/model.js";
import { annotateBlocking } from "../js/replay.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).join(" ").split("--").filter(Boolean)
    .map((s) => { const [k, v] = s.trim().split(/\s+/); return [k, v ?? true]; }));
const GAMES = parseInt(args.games ?? "100", 10);
const abs = (p) => (isAbsolute(p) ? p : join(ROOT, p));

const CHOOSE_OPTS = { totalPlayouts: 90, budgetMs: 60, maxCandidates: 8 };

function playRecorded(nPlayers, theta) {
  const cfg = E.standardConfig(nPlayers);
  let st = E.GameState.deal(cfg);
  const beliefs = [];
  for (let p = 0; p < nPlayers; p++) beliefs.push(new BeliefState(cfg, p, st.hands[p]));
  const rec = { numPlayers: nPlayers, moves: [], scores: null };
  let guard = 0;
  while (!st.isTerminal() && guard++ < 400) {
    const me = st.turn;
    beliefs[me].syncMyHand(st.hands[me]);
    const { move, thought } = chooseMove(st, me, beliefs[me], { ...CHOOSE_OPTS, theta });
    rec.moves.push({
      seat: me,
      tiles: move ? [...move.tiles] : null,
      counts: st.hands.map((h) => h.length),
      currentBefore: st.current ? [...st.current.tiles] : null,
      thought,
    });
    const curTiles = st.current ? st.current.tiles : null;
    for (let p = 0; p < nPlayers; p++) {
      if (move === null) beliefs[p].observePass(me, curTiles);
      else beliefs[p].observePlay(me, move.tiles);
    }
    st = st.apply(move);
  }
  rec.scores = E.roundScores(st);
  return rec;
}

function analyze(records) {
  let oppThreat = 0, blocks = 0, bigThreat = 0;
  let oppNo = 0, bigNo = 0;
  for (const rec of records) {
    const events = annotateBlocking(rec);
    blocks += events.length;
    for (const mv of rec.moves) {
      if (mv.currentBefore !== null || !mv.tiles) continue;   // リードのみ
      const threat = mv.counts.some((c, p) => p !== mv.seat && c >= 1 && c <= 2);
      const big = mv.tiles.length >= 2;
      // 多枚リードが物理的に可能か（手牌枚数）で機会を制限しない — 全リードを母数にする
      if (threat) { oppThreat++; if (big) bigThreat++; }
      else { oppNo++; if (big) bigNo++; }
    }
  }
  const r = (a, b) => (b ? +(a / b).toFixed(4) : null);
  return {
    games: records.length,
    oppThreat, blocks, blockRate: r(blocks, oppThreat),
    bigThreatRate: r(bigThreat, oppThreat),
    oppNoThreat: oppNo, bigNoThreatRate: r(bigNo, oppNo),
  };
}

const list = JSON.parse(readFileSync(abs(args.thetas), "utf8"));
const thetas = [{ gen: 0, theta: { ...DEFAULT_THETA } }, ...list];
const result = [];
for (const { gen, theta } of thetas) {
  const recs = [];
  const sizes = [3, 5];
  for (let g = 0; g < GAMES; g++) {
    recs.push(playRecorded(sizes[g % sizes.length], theta));
    if ((g + 1) % 25 === 0) console.log(`[gen${gen}] ${g + 1}/${GAMES}`);
  }
  const a = analyze(recs);
  result.push({ gen, ...a });
  console.log(`gen${gen}`, JSON.stringify(a));
}
writeFileSync(abs(args.out ?? "exp_curve_result.json"), JSON.stringify(result, null, 2));
console.log("done");
