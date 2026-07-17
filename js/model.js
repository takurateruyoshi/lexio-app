// model.js — 正準モデル（θ）の定義と読み込み
// 全クライアントは同一の model/weights.json を使う（ブラウザ内学習はしない）。
// 値の初期点は旧ハードコード定数だが、最終値は自己対戦学習パイプラインが決める。
"use strict";

export const DEFAULT_THETA = {
  v: 1,
  gen: 0,            // 学習世代
  games: 0,          // 累計学習対局数
  // 候補手の事前ランク（枝刈り順序）
  wSize: 1.2,        // 多く減らせる手の選好
  wStrength: -0.05,  // 強牌温存（最大強度への係数）
  wTwos: -0.8,       // 2 の温存
  wPass: 0.5,        // PASS の基礎スコア
  // ロールアウト方策
  rPass: 0.2,        // 応手で上回れてもパスする率
  rComboPref: 0.35,  // リードで複数枚を優先する率
  rFivePref: 0.3,    // リードで5枚役を選ぶ率（検出できた場合）
  // 信念（ベイズ）
  softPassAccept: 0.2, // 戦略的パスの許容率
};

let THETA = { ...DEFAULT_THETA };

export function getTheta() { return THETA; }
export function setTheta(t) {
  THETA = { ...DEFAULT_THETA, ...(t || {}) };
  return THETA;
}

// ブラウザ起動時に正準モデルを取得（失敗時は初期値のまま）
export async function loadModel(url = "model/weights.json") {
  try {
    const r = await fetch(url, { cache: "no-cache" });
    if (r.ok) setTheta(await r.json());
  } catch { /* offline 等は初期値で続行 */ }
  return THETA;
}
