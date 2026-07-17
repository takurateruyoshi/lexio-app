// tutorial.js — 誘導型チュートリアル（固定シナリオの実対局・最後は自分が勝つ）
// 各ステップにルール画面から切り出したスニペットを表示し、ルール＝実践を結びつける。
"use strict";
import { GameController } from "./game.js";
import { rt, RULE_SNIPPETS } from "./ui.js";
import { makeTile as T, tileRank, tileSuit } from "./engine.js";

// ---- 固定シナリオ（2人戦・9ランク・12枚・あなたが勝つ） ----
const MY_HAND = [
  T(3,0), T(3,3),                         // ☁3 ☀3
  T(5,0), T(5,1),                         // 5ペア
  T(1,2),                                 // ☾1
  T(4,0), T(4,1),                         // 4ペア
  T(5,2), T(6,2), T(7,0), T(8,0), T(9,2), // ストレート 5-6-7-8-9（最後に出し切る）
];
const OPP_HAND = [
  T(3,2),                                 // ☾3
  T(9,1), T(9,3),                         // 9ペア
  T(7,1),                                 // ★7
  T(2,0), T(2,1),                         // 2ペア
  T(3,1), T(4,2), T(5,3), T(6,0), T(7,3), // ストレート 3-4-5-6-7
  T(8,3),                                 // ☀8（出さずに残る → あなたの勝ち）
];

// who:0=あなた / 1=先生
const STEPS = [
  { who: 0, type: "play", tiles: [T(3,0)],
    text: "最弱の牌からスタート", snippet: RULE_SNIPPETS.strength },
  { who: 1, type: "play", tiles: [T(3,2)] },
  { who: 0, type: "play", tiles: [T(3,3)],
    text: "同じ3でもスートで勝てる", snippet: RULE_SNIPPETS.suits },
  { who: 1, type: "pass" },
  { who: 0, type: "play", tiles: [T(5,0), T(5,1)],
    text: "2枚選んでペアを出そう", snippet: RULE_SNIPPETS.pair },
  { who: 1, type: "play", tiles: [T(9,1), T(9,3)] },
  { who: 0, type: "pass",
    text: "勝てない時はパス。抜けじゃない", snippet: RULE_SNIPPETS.pass },
  { who: 1, type: "play", tiles: [T(7,1)] },
  { who: 0, type: "play", tiles: [T(1,2)],
    text: "1 は数字より強い", snippet: RULE_SNIPPETS.one },
  { who: 1, type: "pass" },
  { who: 0, type: "play", tiles: [T(4,0), T(4,1)],
    text: "場が流れたら自由にリード", snippet: RULE_SNIPPETS.pair },
  { who: 1, type: "play", tiles: [T(2,0), T(2,1)] },
  { who: 0, type: "pass",
    text: "2 は最強。無理せずパス", snippet: RULE_SNIPPETS.two },
  { who: 1, type: "play", tiles: [T(3,1), T(4,2), T(5,3), T(6,0), T(7,3)] },
  { who: 0, type: "play", tiles: [T(5,2), T(6,2), T(7,0), T(8,0), T(9,2)],
    text: "5枚役には5枚役！ 上のストレートで勝負", snippet: RULE_SNIPPETS.five },
  // ↑ これで手札0枚 = あなたの勝ち！
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
      return `🏆 <b>あなたの勝ち！</b> 先生の残り1枚ぶんチップを獲得 — 本番へどうぞ ${RULE_SNIPPETS.settle}`;
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
