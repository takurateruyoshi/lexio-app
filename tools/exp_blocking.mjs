// tools/exp_blocking.mjs — 阻害(blocking)行動の世代間比較実験
//
//   node tools/exp_blocking.mjs [--games 120] [--out result.json]
//
// 各θ(初期gen0 / 現チャンピオン / 模倣系統)で全席同一θの自己対戦を行い、
// リード手番での「追随不能な少牌プレイヤーを塞ぐ多枚リード」の頻度と、
// その際のEV差(阻害手 vs 最良の非阻害手)を計測する。
// AIは常に推定EV最大手を選ぶため、「EVを犠牲にした阻害」は定義上出ない。
// 問いは「学習により阻害が最適解になる局面が増えたか / 僅差の時に阻害へ傾くか」。
"use strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../js/engine.js";
import { BeliefState, chooseMove } from "../js/ai.js";
import { DEFAULT_THETA } from "../js/model.js";
import { annotateBlocking } from "../js/replay.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).join(" ").split("--").filter(Boolean)
    .map((s) => { const [k, v] = s.trim().split(/\s+/); return [k, v ?? true]; }));
const GAMES = parseInt(args.games ?? "120", 10);
const OUT = args.out ? join(ROOT, args.out) : null;

const CHOOSE_OPTS = { totalPlayouts: 90, budgetMs: 60, maxCandidates: 8 };

function loadJson(p) { try { return JSON.parse(readFileSync(join(ROOT, p), "utf8")); } catch { return null; } }

// 1局: 全席同一θ。game.js と同形式のラウンド記録を作って返す
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
  rec.finished = [...st.finished];
  return rec;
}

// 集計: 阻害イベント / 機会 / EVマージン
function analyze(records) {
  let opportunities = 0;       // リード手番で、1〜2枚の相手が存在した回数
  let blocks = 0;              // annotateBlocking が検出した阻害リード
  let blocksWithAlt = 0;       // 追随可能な代替手を持ちながら阻害した回数
  const margins = [];          // 阻害時: EV(阻害手) - EV(最良の非阻害手)
  let threatScoreSum = 0, threatN = 0;   // 阻害された少牌プレイヤーの最終収支
  for (const rec of records) {
    const events = annotateBlocking(rec);
    for (const mv of rec.moves) {
      if (mv.currentBefore !== null || !mv.tiles) continue;   // リードのみ
      const someThreat = mv.counts.some((c, p) => p !== mv.seat && c >= 1 && c <= 2);
      if (someThreat) opportunities++;
    }
    for (const ev of events) {
      blocks++;
      if (ev.hadFollowableAlternative) blocksWithAlt++;
      // EVマージン: 選んだ手(=候補表の先頭とは限らないが、実際は最大EV) vs 最良の「小さい」手
      const cands = ev.evTable || [];
      const chosenEv = cands.find((c) => c.size === ev.size)?.ev;
      const maxThreat = Math.max(...ev.threatCounts);
      const altEv = Math.max(...cands.filter((c) => c.size >= 1 && c.size <= maxThreat)
                                     .map((c) => c.ev ?? -Infinity), -Infinity);
      if (chosenEv != null && altEv !== -Infinity) margins.push(chosenEv - altEv);
      for (const t of ev.threats) { threatScoreSum += rec.scores[t]; threatN++; }
    }
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    games: records.length,
    opportunities,
    blocks,
    blockRate: opportunities ? +(blocks / opportunities).toFixed(4) : null,
    blocksWithFollowableAlt: blocksWithAlt,
    evMarginMean: margins.length ? +mean(margins).toFixed(3) : null,
    evMarginN: margins.length,
    smallMargins: margins.filter((m) => m < 0.5).length,   // 僅差(≈同EV)で阻害を選んだ回数
    blockedThreatMeanScore: threatN ? +(threatScoreSum / threatN).toFixed(2) : null,
  };
}

// ---- メイン ----
const thetas = [
  { name: "gen0_default", theta: { ...DEFAULT_THETA } },
];
const champ = loadJson("model/weights.json");
if (champ) thetas.push({ name: `champion_gen${champ.gen}`, theta: champ });
const human = loadJson("model/weights_human.json");
if (human) thetas.push({ name: `human_lineage_gen${human.gen}`, theta: human });

const result = {};
for (const { name, theta } of thetas) {
  const recs = [];
  const sizes = [3, 5];
  for (let g = 0; g < GAMES; g++) {
    recs.push(playRecorded(sizes[g % sizes.length], theta));
    if ((g + 1) % 20 === 0) console.log(`[${name}] ${g + 1}/${GAMES}`);
  }
  result[name] = analyze(recs);
  console.log(name, JSON.stringify(result[name]));
}
if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log("done");
