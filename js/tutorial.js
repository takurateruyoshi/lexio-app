// tutorial.js — ステップ式チュートリアル + 練習対局のヒント文言
"use strict";
import { $, rt, meldHtml } from "./ui.js";

const STEPS = [
  {
    title: "① ゲームの目的",
    html: `<p>レキシオは<b>手札を最初に出し切った人が勝ち</b>のゲームです。</p>
      <p>誰かが出し切った瞬間にラウンドが終わり、残った手札の枚数差をチップで精算します。
      残り枚数が少ないほど損は小さくなるので、最後まで気を抜かずに減らしましょう。</p>`,
  },
  {
    title: "② 牌の強さ",
    html: `<div class="rule-row">${rt(3,0)}<span class="rule-sep">&lt;</span>${rt(4,0)}
      <span class="rule-ellipsis">…</span><span class="rule-sep">&lt;</span>${rt(9,0)}
      <span class="rule-sep">&lt;</span>${rt(1,0)}<span class="rule-sep">&lt;</span>${rt(2,0)}</div>
      <p><b>3 が最弱、2 が最強</b>です。1 と 2 は大きい数字よりさらに強い特別な牌。</p>
      <div class="rule-row">${rt(7,0)}<span class="rule-sep">&lt;</span>${rt(7,1)}
      <span class="rule-sep">&lt;</span>${rt(7,2)}<span class="rule-sep">&lt;</span>${rt(7,3)}</div>
      <p>同じ数字はスート（☁雲 &lt; ★星 &lt; ☾月 &lt; ☀太陽）で決着します。</p>`,
  },
  {
    title: "③ 役（出し方の種類）",
    html: `<div class="rule-row"><span class="rule-label">単騎</span>${rt(8,2)}</div>
      <div class="rule-row"><span class="rule-label">ペア</span>${meldHtml([[8,1],[8,3]])}</div>
      <div class="rule-row"><span class="rule-label">トリプル</span>${meldHtml([[8,0],[8,1],[8,2]])}</div>
      <div class="rule-row"><span class="rule-label">5枚役</span>${meldHtml([[4,0],[5,1],[6,2],[7,0],[8,3]])}</div>
      <p><b>同じ枚数同士でしか勝負できません</b>。ペアにはペア、単騎には単騎で上回ります。
      5枚役の強さはストレート &lt; フラッシュ &lt; フルハウス &lt; フォーカード &lt; ストレートフラッシュ。</p>`,
  },
  {
    title: "④ 画面の操作",
    html: `<p>自分の手番になると画面下の手牌が光ります。</p>
      <p><b>牌をタップして選び</b>、右下の<b>「出す」</b>ボタンで場に出します。
      出せない・出したくない時は<b>「パス」</b>。</p>
      <p>間違えて選んだ牌はもう一度タップで選択解除。右上の「ログ」からAIの読み
      （勝率・期待収支）も見られます。</p>`,
  },
  {
    title: "⑤ 場の流れ",
    html: `<p>リーダーが好きな役を出し、時計回りに「より強い同じ枚数の役」か「パス」を選びます。</p>
      <p>パスしても抜けにはなりません — <b>誰かが新しい役を出せばまた出せます</b>。</p>
      <p>全員がパスすると場が流れ、最後に出した人が次のリーダーに。
      強い牌をいつ使うかが勝負どころです。</p>`,
  },
  {
    title: "⑥ 精算とコツ",
    html: `<p>ラウンド終了時、残り枚数の差を互いにチップで支払います。</p>
      <div class="rule-row"><span class="rule-label">注意!</span>
      ${rt(2,0)}<span class="rule-note">が手札に残ると支払いが×2（2枚で×4…）</span></div>
      <p>最強の 2 は強力ですが、抱えたまま終わると大損。<b>使い所を見極めましょう</b>。</p>
      <p>それでは、ヒント付きの練習対局へどうぞ！</p>`,
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
