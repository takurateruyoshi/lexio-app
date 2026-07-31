// tools/exp_coop.mjs — 邪魔の受益者分析（利己的な邪魔か、協力的な邪魔かの切り分け）
//
//   node tools/exp_coop.mjs [--games 60] [--k 6] [--out data/exp_coop.json]
//
// チャンピオンθの自己対戦中、「代替手を持ちながら多枚リードで塞いだ」手番ごとに
// 反実仮想ロールアウトを行う: 同一局面から (A)塞ぐ手 / (B)最良の追随可能手 を打ち、
// それぞれ K 回プレイアウトして最終収支を比較する。
//   Δ自分   = 邪魔した本人の収支差  (＞0 なら利己的)
//   Δ標的   = 塞がれた少牌プレイヤーの収支差 (＜0 なら実害)
//   Δ第三者 = それ以外のプレイヤーの収支差 (＞0 なら結果的に他者も受益)
// EVを犠牲にする「協力」は設計上出ない。問いは「邪魔の利得が誰に落ちるか」。
"use strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../js/engine.js";
import { BeliefState, chooseMove } from "../js/ai.js";
import { DEFAULT_THETA } from "../js/model.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).join(" ").split("--").filter(Boolean)
    .map((s) => { const [k, v] = s.trim().split(/\s+/); return [k, v ?? true]; }));
const GAMES = parseInt(args.games ?? "60", 10);
const K = parseInt(args.k ?? "6", 10);
const abs = (p) => (isAbsolute(p) ? p : join(ROOT, p));

const MAIN_OPTS = { totalPlayouts: 90, budgetMs: 60, maxCandidates: 8 };
const RO_OPTS = { totalPlayouts: 24, budgetMs: 20, maxCandidates: 6 };

function loadJson(p) { try { return JSON.parse(readFileSync(join(ROOT, p), "utf8")); } catch { return null; } }
const champ = loadJson("model/weights.json");
const theta = champ ? { ...DEFAULT_THETA, ...champ } : { ...DEFAULT_THETA };

// 与えられた局面から終局までθ同一でプレイし、最終収支を返す
function playout(st) {
  const n = st.cfg.numPlayers;
  const beliefs = [];
  for (let p = 0; p < n; p++) beliefs.push(new BeliefState(st.cfg, p, st.hands[p]));
  let guard = 0;
  while (!st.isTerminal() && guard++ < 400) {
    const me = st.turn;
    beliefs[me].syncMyHand(st.hands[me]);
    const { move } = chooseMove(st, me, beliefs[me], { ...RO_OPTS, theta });
    const cur = st.current ? st.current.tiles : null;
    for (let p = 0; p < n; p++) {
      if (move === null) beliefs[p].observePass(me, cur);
      else beliefs[p].observePlay(me, move.tiles);
    }
    st = st.apply(move);
  }
  return E.roundScores(st);
}

function meanScores(st0, move, k) {
  const n = st0.cfg.numPlayers;
  const acc = new Array(n).fill(0);
  for (let i = 0; i < k; i++) {
    const sc = playout(st0.apply(move));
    for (let p = 0; p < n; p++) acc[p] += sc[p];
  }
  return acc.map((x) => x / k);
}

const events = [];
let played = 0;
const sizes = [3, 5];
for (let g = 0; g < GAMES; g++) {
  const nPlayers = sizes[g % sizes.length];
  const cfg = E.standardConfig(nPlayers);
  let st = E.GameState.deal(cfg);
  const beliefs = [];
  for (let p = 0; p < nPlayers; p++) beliefs.push(new BeliefState(cfg, p, st.hands[p]));
  let guard = 0;
  while (!st.isTerminal() && guard++ < 400) {
    const me = st.turn;
    beliefs[me].syncMyHand(st.hands[me]);
    const { move, thought } = chooseMove(st, me, beliefs[me], { ...MAIN_OPTS, theta });

    // 邪魔リードの検出: リード手番・多枚(≥2)・1〜2枚の相手が追随不能・代替手あり
    if (st.current === null && move && move.size >= 2 && thought && thought.candidates) {
      const threats = [];
      for (let p = 0; p < nPlayers; p++) {
        const c = st.hands[p].length;
        if (p !== me && c >= 1 && c <= 2 && c < move.size) threats.push(p);
      }
      const maxThreat = Math.max(0, ...st.hands
        .map((h, p) => (p !== me && h.length >= 1 && h.length <= 2 ? h.length : 0)));
      if (threats.length > 0 && maxThreat > 0) {
        // 追随可能な代替手のうち推定EV最良のものを、候補表と役列挙の突き合わせで特定
        const altCand = thought.candidates.find((c) => c.size >= 1 && c.size <= maxThreat);
        if (altCand) {
          const melds = E.enumerateMelds(st.hands[me], cfg)
            .filter((m) => m.size >= 1 && m.size <= maxThreat);
          const altMove = melds.find((m) => E.meldText(m) === altCand.move) ?? melds[0];
          if (altMove) {
            const a = meanScores(st, move, K);      // 塞いだ場合
            const b = meanScores(st, altMove, K);   // 小さく出した場合
            const others = [];
            for (let p = 0; p < nPlayers; p++) {
              if (p === me || threats.includes(p)) continue;
              others.push(a[p] - b[p]);
            }
            events.push({
              actor: a[me] - b[me],
              target: threats.reduce((s, t) => s + (a[t] - b[t]), 0) / threats.length,
              others: others.length ? others.reduce((x, y) => x + y, 0) / others.length : null,
            });
          }
        }
      }
    }

    const cur = st.current ? st.current.tiles : null;
    for (let p = 0; p < nPlayers; p++) {
      if (move === null) beliefs[p].observePass(me, cur);
      else beliefs[p].observePlay(me, move.tiles);
    }
    st = st.apply(move);
  }
  played++;
  if (played % 5 === 0) console.log(`${played}/${GAMES} games, ${events.length} events`);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const withOthers = events.filter((e) => e.others !== null);
const result = {
  theta: champ ? `champion_gen${champ.gen}` : "gen0_default",
  games: played, events: events.length, k: K,
  dActorMean: +mean(events.map((e) => e.actor)).toFixed(2),
  dTargetMean: +mean(events.map((e) => e.target)).toFixed(2),
  dOthersMean: withOthers.length ? +mean(withOthers.map((e) => e.others)).toFixed(2) : null,
  actorGainRate: +(events.filter((e) => e.actor > 0).length / events.length).toFixed(3),
  targetLossRate: +(events.filter((e) => e.target < 0).length / events.length).toFixed(3),
  othersGainRate: withOthers.length
    ? +(withOthers.filter((e) => e.others > 0).length / withOthers.length).toFixed(3) : null,
};
console.log(JSON.stringify(result, null, 2));
writeFileSync(abs(args.out ?? "data/exp_coop.json"), JSON.stringify({ result, events }, null, 2));
console.log("done");
