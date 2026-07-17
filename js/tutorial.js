// tutorial.js — 誘導型チュートリアル（固定シナリオの実対局で学ぶ）
// 毎回同じ配牌・同じ相手スクリプト。各ステップで選べる手は一通りだけ。
"use strict";
import { GameController } from "./game.js";
import { rt } from "./ui.js";
import { makeTile as T, tileRank, tileSuit } from "./engine.js";

// ---- 固定シナリオ（2人戦・9ランク・12枚） ----
const MY_HAND = [
  T(3,0), T(3,3),        // ☁3 ☀3   … 単騎とスートの強弱
  T(5,0), T(5,3),        // 5ペア
  T(1,2),                // ☾1      … 1は数字より強い
  T(4,0), T(4,1),        // 4ペア
  T(6,0), T(6,1), T(8,0), T(8,1), T(9,0),   // 残り（学習後に残る牌）
];
const OPP_HAND = [
  T(3,2),                // ☾3
  T(9,1), T(9,2),        // 9ペア
  T(7,1),                // ★7
  T(2,0), T(2,1),        // 2ペア
  T(3,1), T(4,2), T(5,2), T(6,2), T(7,0),   // ストレート 3-4-5-6-7
  T(8,3),                // ☀8（最後に出し切る）
];

// who:0=あなた / 1=先生。あなたの手番には text と期待手が付く。
const STEPS = [
  { who: 0, type: "play", tiles: [T(3,0)],
    text: "最弱の牌からスタート" },
  { who: 1, type: "play", tiles: [T(3,2)] },
  { who: 0, type: "play", tiles: [T(3,3)],
    text: "同じ3でもスートで勝てる（☀は☾より強い）" },
  { who: 1, type: "pass" },
  { who: 0, type: "play", tiles: [T(5,0), T(5,3)],
    text: "リードは自由 — 2枚選んでペアを出そう" },
  { who: 1, type: "play", tiles: [T(9,1), T(9,2)] },
  { who: 0, type: "pass",
    text: "9のペアには勝てない…でもパスは抜けじゃない" },
  { who: 1, type: "play", tiles: [T(7,1)] },
  { who: 0, type: "play", tiles: [T(1,2)],
    text: "1 は 9 よりも強い特別な牌" },
  { who: 1, type: "pass" },
  { who: 0, type: "play", tiles: [T(4,0), T(4,1)],
    text: "場が流れたら自由にリード" },
  { who: 1, type: "play", tiles: [T(2,0), T(2,1)] },
  { who: 0, type: "pass",
    text: "2 は最強。無理せずパス" },
  { who: 1, type: "play", tiles: [T(3,1), T(4,2), T(5,2), T(6,2), T(7,0)] },
  { who: 0, type: "pass",
    text: "5枚役には5枚役でしか勝てない" },
  { who: 1, type: "play", tiles: [T(8,3)] },   // 先生が出し切って終了
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

  // 選択を許可する牌（期待手のみ）
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
      return "🎉 チュートリアル完了！ 精算は「残り枚数 × 2の倍率」— 本番で会いましょう";
    }
    const s = this.step();
    if (!s) return "";
    if (s.who === 1) return "先生の番…";
    if (s.type === "pass") return `${s.text}　→ <b>パス</b>`;
    return `${s.text}　${tilesHtml(s.tiles)}`;
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
    this.onRender(this);   // 自身を渡す（呼び出し側の変数初期化順に依存しない）
  }
}
