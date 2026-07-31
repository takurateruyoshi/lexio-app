// rank.js — 端末ごとのベストスコア記録（ローカル）とランキング用ユーティリティ
// 端末IDそのものは牌譜に載せず、短いハッシュ（公開識別子）だけを使う。
"use strict";

const KEY = "lexio.rank.v1";

// djb2 ハッシュ → 8桁hex。ランキングで端末を同定するための匿名ID
export function devHash(id) {
  if (!id) return null;
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h * 33) ^ id.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export function getLocalBest() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}

// 1ラウンド分の自分の得点を記録。ベスト更新なら true を返す
export function recordScore(score, name) {
  const cur = getLocalBest() || { best: null, at: null, rounds: 0, name: null };
  cur.rounds += 1;
  if (name) cur.name = name;
  let updated = false;
  if (typeof score === "number" && (cur.best === null || score > cur.best)) {
    cur.best = score;
    cur.at = new Date().toISOString();
    updated = true;
  }
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch {}
  return updated;
}
