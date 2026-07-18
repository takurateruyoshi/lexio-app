// cards.js — Lexio Neo スペシャルカードの定義
// 出典: LexioNeo 同梱スペシャルカード（各自3枚配布・1ラウンド1枚まで）。
// 現在は効果が確定している9種13枚を実装（残り5種はカード文言の確認後に追加予定）。
"use strict";
import { shuffle, classify, beats } from "./engine.js";

export const JOKER_BASE = 1000;   // 仮想牌ID = 1000 + rank*4 + suit
export const isJokerTile = (t) => t >= JOKER_BASE;

// 人数ごとのジョーカー代用範囲（3人:3-5 / 4人:3-6 / 5人:3-7。2人戦はNeo対象外）
export function jokerRange(numPlayers) {
  return { 3: [3, 5], 4: [3, 6], 5: [3, 7] }[numPlayers] || null;
}

export const CARD_DEFS = {
  joker_cloud: { type: "joker", suit: 0, name: "ふわふわの雲", en: "Fluffy Cloud", icon: "☁", copies: 2,
    desc: "雲のワイルド牌として牌と一緒に出せます（同じ色・数字の牌とは一緒に出せません）" },
  joker_star: { type: "joker", suit: 1, name: "穏やかな星灯り", en: "Serene Starlight", icon: "★", copies: 2,
    desc: "星のワイルド牌として牌と一緒に出せます（同じ色・数字の牌とは一緒に出せません）" },
  joker_moon: { type: "joker", suit: 2, name: "柔らかな月光", en: "Mellow Moonlight", icon: "☾", copies: 2,
    desc: "月のワイルド牌として牌と一緒に出せます（同じ色・数字の牌とは一緒に出せません）" },
  joker_sun: { type: "joker", suit: 3, name: "輝く太陽", en: "Radiant Sun", icon: "☀", copies: 2,
    desc: "太陽のワイルド牌として牌と一緒に出せます（同じ色・数字の牌とは一緒に出せません）" },
  new_beginning: { type: "game", name: "新しい始まり", en: "New Beginning", icon: "🔄", copies: 1,
    desc: "牌をシャッフルし直し、配り直すことができます。ラウンドが始まる前に配られた牌を確認したときのみ使用できます" },
  lost_right: { type: "flow", name: "失われた権利", en: "Lost Right", icon: "⛓", copies: 1,
    desc: "牌と一緒に出します。選んだプレイヤーの次の手番を強制的にパスさせます" },
  unwanted_gift: { type: "flow", name: "不要なギフト", en: "Unwanted Gift", icon: "🎁", copies: 1,
    desc: "牌と一緒に出します。自分の手牌1枚を選んだプレイヤーに贈ります" },
  winner_takes: { type: "ending", name: "勝者独占", en: "Winner Takes It All", icon: "👑", copies: 1,
    desc: "ラウンドの1位だけが、他のプレイヤーに支払われるチップをすべて回収することができます" },
  helping_hand: { type: "ending", name: "救いの手", en: "Helping Hand", icon: "🤝", copies: 1,
    desc: "精算時・最下位のみ。自分の支払いを各プレイヤー1点ずつに軽減します" },
};

// ジョーカーの代用数字の候補を自動列挙する。
// tileIds: 一緒に出す牌 / currentTiles: 場の役の牌ID配列（リード時は null）。
// 候補 = 範囲内 && 同一の牌（同色同数字）と重複しない && 役として成立 && 場を上回る。
export function jokerRankCandidates(tileIds, cardSuit, numPlayers, maxRank, currentTiles) {
  const range = jokerRange(numPlayers);
  if (!range) return [];
  const cur = currentTiles && currentTiles.length ? classify(currentTiles, maxRank) : null;
  const out = [];
  for (let r = range[0]; r <= range[1]; r++) {
    if (tileIds.includes(r * 4 + cardSuit)) continue;
    const cand = classify([...tileIds, JOKER_BASE + r * 4 + cardSuit], maxRank);
    if (cand && beats(cand, cur)) out.push(r);
  }
  return out;
}

// シャッフル済みデッキ（実装済みカードのみ）
export function buildDeck() {
  const deck = [];
  for (const [id, def] of Object.entries(CARD_DEFS)) {
    for (let i = 0; i < def.copies; i++) deck.push(id);
  }
  return shuffle(deck);
}
