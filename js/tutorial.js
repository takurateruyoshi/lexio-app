// tutorial.js — 誘導型チュートリアル（固定シナリオの実対局・最後は自分が勝つ）
// 各ステップにルール画面から切り出したスニペットを表示し、ルール＝実践を結びつける。
"use strict";
import { GameController } from "./game.js";
import { rt, RULE_SNIPPETS } from "./ui.js";
import { makeTile as T, tileRank, tileSuit } from "./engine.js";

// ---- 固定シナリオ（2人戦・9ランク・12枚・あなたが勝つ） ----
const MY_HAND = [
  T(3,0),                                 // ☁3（最弱リード）
  T(6,0),                                 // ☁6（大きい数字で上回る）
  T(5,0), T(5,3),                         // ☁5 ☀5（スートの強弱）
  T(4,0), T(4,1),                         // 4ペア
  T(1,2),                                 // ☾1（1の強さ）
  T(5,1), T(6,1), T(7,0), T(8,0), T(9,0), // ストレート 5-6-7-8-9（出し切って勝つ）
];
const OPP_HAND = [
  T(4,2),                                 // ☾4
  T(5,2),                                 // ☾5
  T(9,1), T(9,2),                         // 9ペア
  T(7,1),                                 // ★7
  T(2,0), T(2,1),                         // 2ペア（出さずに残る → 支払い×4の実演）
  T(3,3), T(6,3), T(8,3), T(8,2), T(9,3), // 残り（出さない）
];

// who:0=あなた / 1=先生
const STEPS = [
  { who: 0, type: "play", tiles: [T(3,0)],
    text: "最弱の牌からスタート", snippet: RULE_SNIPPETS.strength },
  { who: 1, type: "play", tiles: [T(4,2)] },
  { who: 0, type: "play", tiles: [T(6,0)],
    text: "大きい数字で上回ろう", snippet: RULE_SNIPPETS.strength },
  { who: 1, type: "pass" },
  { who: 0, type: "play", tiles: [T(5,0)],
    text: "場が流れたら自由にリード" },
  { who: 1, type: "play", tiles: [T(5,2)] },
  { who: 0, type: "play", tiles: [T(5,3)],
    text: "同じ5でもスートで勝てる", snippet: RULE_SNIPPETS.suits },
  { who: 1, type: "pass" },
  { who: 0, type: "play", tiles: [T(4,0), T(4,1)],
    text: "2枚選んでペアを出そう", snippet: RULE_SNIPPETS.pair },
  { who: 1, type: "play", tiles: [T(9,1), T(9,2)] },
  { who: 0, type: "pass",
    text: "勝てない時はパス。抜けじゃない", snippet: RULE_SNIPPETS.pass },
  { who: 1, type: "play", tiles: [T(7,1)] },
  { who: 0, type: "play", tiles: [T(1,2)],
    text: "1 は 9 より強い（2 はさらに上）", snippet: RULE_SNIPPETS.one },
  { who: 1, type: "pass" },
  { who: 0, type: "play", tiles: [T(5,1), T(6,1), T(7,0), T(8,0), T(9,0)],
    text: "5枚役で出し切り！ 役の強さは一番強い数字で決まる", snippet: RULE_SNIPPETS.five },
  // ↑ 手札0枚 = あなたの勝ち。先生は 2 を2枚残したので支払い×4！
];

const eqSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const tilesHtml = (tiles) => tiles.map((t) => rt(tileRank(t), tileSuit(t))).join("");

export class Tutorial {
  constructor(onRender) {
    this.onRender = onRender || (() => {});
    this.idx = 0;
    this._sched = false;
    this.ctrl = new GameController(2,
      [{ kind: "human", name: "あなた" }, { kind: "human", name: "先生" }],
      1, () => this._tick(),
      { fixedDeal: [MY_HAND, OPP_HAND], turnLimitSec: 0 });
    this._tick();
  }

  view() { return this.ctrl.view(0); }
  step() { return STEPS[this.idx] || null; }
  done() { return this.ctrl.state.isTerminal(); }

  selectable() {
    const s = this.step();
    return new Set(s && s.who === 0 && s.type === "play" ? s.tiles : []);
  }

  expectPass() {
    const s = this.step();
    return !!(s && s.who === 0 && s.type === "pass");
  }

  instructionHtml() {
    if (this.done()) {
      return `🏆 <b>あなたの勝ち！</b> 先生は <b>2</b> を2枚残したので支払い<b>×4</b>
        <div class="tut-snippet">${RULE_SNIPPETS.two}</div>`;
    }
    const s = this.step();
    if (!s) return "";
    if (s.who === 1) return "先生の番…";
    const head = s.type === "pass" ? `${s.text}　→ <b>パス</b>` : `${s.text}`;
    return `${head}${s.snippet ? `<div class="tut-snippet">${s.snippet}</div>` : ""}`;
  }

  tryPlay(tiles) {
    const s = this.step();
    if (!s || s.who !== 0 || s.type !== "play") return "今は出せません";
    if (!eqSet(tiles, s.tiles)) return "光っている牌を選んでね";
    this.idx++;
    const err = this.ctrl.play(0, tiles);
    if (err) { this.idx--; return err; }
    return null;
  }

  tryPass() {
    const s = this.step();
    if (!s || s.who !== 0 || s.type !== "pass") return "ここはパスの場面ではありません";
    this.idx++;
    const err = this.ctrl.pass(0);
    if (err) { this.idx--; return err; }
    return null;
  }

  _tick() {
    const s = this.step();
    if (s && s.who === 1 && !this._sched &&
        this.ctrl.state.turn === 1 && !this.ctrl.state.isTerminal()) {
      this._sched = true;
      setTimeout(() => {
        this._sched = false;
        const cur = this.step();
        if (!cur || cur.who !== 1) return;
        this.idx++;
        if (cur.type === "pass") this.ctrl.pass(1);
        else this.ctrl.play(1, cur.tiles);
      }, 1100);
    }
    this.onRender(this);
  }
}
