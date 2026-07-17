// tutorial.js — ステップ式チュートリアル + 練習対局のヒント文言
"use strict";
import { $, rt, meldHtml } from "./ui.js";

const GT = `<span class="rule-sep">→</span>`;
const LT2 = `<span class="rule-sep">&lt;</span>`;
const STEPS = [
  {
    title: "目的",
    html: `<div class="tut-big">手札を最初に出し切ったら勝ち 🏆</div>
      <div class="rule-row tut-center">${meldHtml([[3,0],[7,1],[9,2],[1,0],[2,3]])}
      ${GT}<span class="tut-zero">0枚</span> 👑</div>`,
  },
  {
    title: "牌の強さ",
    html: `<div class="rule-row tut-center">
      ${rt(3,0)}${LT2}${rt(4,0)}<span class="rule-ellipsis">…</span>${LT2}${rt(9,0)}${LT2}${rt(1,0)}${LT2}${rt(2,0)}</div>
      <div class="tut-caption">3 が最弱 ・ 2 が最強</div>
      <div class="rule-row tut-center">${rt(7,0)}${LT2}${rt(7,1)}${LT2}${rt(7,2)}${LT2}${rt(7,3)}</div>`,
  },
  {
    title: "役",
    html: `<div class="rule-row"><span class="rule-label">単騎</span>${rt(8,2)}</div>
      <div class="rule-row"><span class="rule-label">ペア</span>${meldHtml([[8,1],[8,3]])}</div>
      <div class="rule-row"><span class="rule-label">トリプル</span>${meldHtml([[8,0],[8,1],[8,2]])}</div>
      <div class="rule-row"><span class="rule-label">5枚役</span>${meldHtml([[4,0],[5,1],[6,2],[7,0],[8,3]])}</div>
      <div class="tut-caption">同じ枚数同士でだけ勝負</div>`,
  },
  {
    title: "操作",
    html: `<div class="tut-big">タップで選ぶ ${GT} <span class="tut-btn gold">出す</span></div>
      <div class="tut-big">出せない時は <span class="tut-btn">パス</span></div>
      <div class="tut-caption">自分の番になると手牌が光ります</div>`,
  },
  {
    title: "場の流れ",
    html: `<div class="rule-row tut-center">${rt(5,0)}${LT2}${rt(9,2)}${LT2}${rt(2,3)}</div>
      <div class="tut-caption">同じ枚数で、より強く</div>
      <div class="rule-row tut-center"><span class="tut-btn">パス</span>${GT}
      ${rt(9,2)}${GT}<span class="tut-ok">また出せる</span></div>
      <div class="tut-caption">全員パスで場が流れる</div>`,
  },
  {
    title: "精算",
    html: `<div class="rule-row tut-center">残り ${meldHtml([[5,0],[9,1]])} ${GT}
      <span class="tut-zero">−2点</span></div>
      <div class="rule-row tut-center">${rt(2,0)} が残ると <span class="tut-zero">×2</span>
      　${meldHtml([[2,0],[2,1]])} ${GT} <span class="tut-zero">×4</span></div>
      <div class="tut-caption">それでは練習対局へ！</div>`,
  },
];

let page = 0;
let onPractice = null;

function render() {
  $("tutorial-title").textContent = STEPS[page].title;
  $("tutorial-body").innerHTML = STEPS[page].html;
  $("tutorial-step").textContent = `${page + 1} / ${STEPS.length}`;
  $("tutorial-prev").disabled = page === 0;
  $("tutorial-next").textContent = page === STEPS.length - 1 ? "練習対局を始める" : "次へ →";
}

export function showTutorial(practiceCb) {
  onPractice = practiceCb;
  page = 0;
  render();
  $("tutorial-overlay").classList.remove("hidden");
}

export function wireTutorial() {
  $("tutorial-prev").addEventListener("click", () => { if (page > 0) { page--; render(); } });
  $("tutorial-next").addEventListener("click", () => {
    if (page < STEPS.length - 1) { page++; render(); }
    else {
      $("tutorial-overlay").classList.add("hidden");
      onPractice && onPractice();
    }
  });
  $("tutorial-overlay").addEventListener("click", (e) => {
    if (e.target === $("tutorial-overlay")) $("tutorial-overlay").classList.add("hidden");
  });
}

// 練習対局の状況別ヒント（UI文言のみ・AIには無介入）
export function practiceHint(view) {
  if (!view) return "";
  if (view.terminal) return "🎉 練習対局おつかれさま！ タイトルから本番の対戦へどうぞ。";
  if (view.yourTurn) {
    if (view.mustLead) {
      return "💡 あなたがリーダー。好きな役（単騎/ペア/トリプル/5枚役）を出せます。弱い牌から整理するのが基本。";
    }
    if (view.canPass) {
      return `💡 場は${view.currentMeld ? view.currentMeld.size + "枚役" : "-"}。同じ枚数でより強い役を出すか「パス」。パスしても、誰かが出せばまたあなたの番が回ってきます。`;
    }
  }
  const low = view.players.find((p) => !p.isYou && !p.finished && p.count <= 2);
  if (low) return `⚠ ${low.name} は残り${low.count}枚！ 上がられないように流れを考えましょう。`;
  return "相手の手番です。出された役と枚数をよく見ておきましょう。";
}
