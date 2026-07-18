// cards.js — Lexio Neo スペシャルカードの定義
// 出典: LexioNeo 同梱スペシャルカード（各自3枚配布・1ラウンド1枚まで）。
// 現在は効果が確定している9種13枚を実装（残り5種はカード文言の確認後に追加予定）。
"use strict";
import { shuffle } from "./engine.js";

export const JOKER_BASE = 1000;   // 仮想牌ID = 1000 + rank*4 + suit
export const isJokerTile = (t) => t >= JOKER_BASE;

// 人数ごとのジョーカー代用範囲（3人:3-5 / 4人:3-6 / 5人:3-7。2人戦はNeo対象外）
export function jokerRange(numPlayers) {
  return { 3: [3, 5], 4: [3, 6], 5: [3, 7] }[numPlayers] || null;
}

export const CARD_DEFS = {
  joker_cloud: { type: "joker", suit: 0, name: "ふわふわの雲", icon: "☁", copies: 2,
    desc: "雲のワイルド牌として牌と一緒に出せる（同時に出す牌と同じ数字は不可）" },
  joker_star: { type: "joker", suit: 1, name: "穏やかな星灯り", icon: "★", copies: 2,
    desc: "星のワイルド牌として牌と一緒に出せる（同時に出す牌と同じ数字は不可）" },
  joker_moon: { type: "joker", suit: 2, name: "柔らかな月光", icon: "☾", copies: 2,
    desc: "月のワイルド牌として牌と一緒に出せる（同時に出す牌と同じ数字は不可）" },
  joker_sun: { type: "joker", suit: 3, name: "輝く太陽", icon: "☀", copies: 2,
    desc: "太陽のワイルド牌として牌と一緒に出せる（同時に出す牌と同じ数字は不可）" },
  new_beginning: { type: "game", name: "新しい始まり", icon: "🔄", copies: 1,
    desc: "配牌直後に全員の牌を配り直す（このラウンドは他のカードを使えない）" },
  lost_right: { type: "flow", name: "失われた権利", icon: "⛓", copies: 1,
    desc: "牌と一緒に出す。選んだプレイヤーの次の手番を強制的にパスさせる" },
  unwanted_gift: { type: "flow", name: "不要なギフト", icon: "🎁", copies: 1,
    desc: "牌と一緒に出す。自分の手牌1枚を選んだプレイヤーに渡す" },
  winner_takes: { type: "ending", name: "勝者独占", icon: "👑", copies: 1,
    desc: "精算時・1位のみ。他プレイヤー同士の支払いをすべて自分が回収する" },
  helping_hand: { type: "ending", name: "救いの手", icon: "🤝", copies: 1,
    desc: "精算時・最下位のみ。自分の支払いを各プレイヤー1点ずつに軽減する" },
};

// シャッフル済みデッキ（実装済みカードのみ）
export function buildDeck() {
  const deck = [];
  for (const [id, def] of Object.entries(CARD_DEFS)) {
    for (let i = 0; i < def.copies; i++) deck.push(id);
  }
  return shuffle(deck);
}
