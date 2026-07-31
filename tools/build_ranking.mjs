// tools/build_ranking.mjs — 収集牌譜から端末ごとのベストスコアを集計し ranking.json を作る
//
//   node tools/build_ranking.mjs [--records games] [--out model/ranking.json]
//
// 対象: players フィールド（端末ハッシュ+表示名。ホストが人間席にのみ付与）を持つ牌譜。
// practice は除外。同一牌譜の重複（再送）は at+round で除去する。
// 出力: { v, updatedAt, rounds, entries: [{ d, n, best, at, rounds }] } 上位100件。
"use strict";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).join(" ").split("--").filter(Boolean)
    .map((s) => { const [k, v] = s.trim().split(/\s+/); return [k, v ?? true]; }));
const abs = (p) => (isAbsolute(p) ? p : join(ROOT, p));
const RECORDS = abs(args.records ?? "games");
const OUT = abs(args.out ?? "model/ranking.json");

function* walkJsonl(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkJsonl(p);
    else if (name.endsWith(".jsonl")) yield p;
  }
}

const byDev = new Map();   // d -> { d, n, nAt, best, at, rounds }
const seen = new Set();
let rounds = 0;

for (const file of walkJsonl(RECORDS)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(rec.players) || !Array.isArray(rec.scores)) continue;
    if (rec.mode === "practice" || rec.mode === "spectate") continue;
    const key = `${rec.at}|${rec.round}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rounds++;
    rec.players.forEach((p, i) => {
      if (!p || !p.d || typeof rec.scores[i] !== "number") return;
      let e = byDev.get(p.d);
      if (!e) { e = { d: p.d, n: null, nAt: "", best: null, at: null, rounds: 0 }; byDev.set(p.d, e); }
      e.rounds++;
      if (p.n && (rec.at || "") >= e.nAt) { e.n = p.n; e.nAt = rec.at || ""; }
      if (e.best === null || rec.scores[i] > e.best) { e.best = rec.scores[i]; e.at = rec.at || null; }
    });
  }
}

const entries = [...byDev.values()]
  .filter((e) => e.best !== null)
  .sort((a, b) => b.best - a.best || b.rounds - a.rounds)
  .slice(0, 100)
  .map(({ nAt, ...e }) => e);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  v: 1,
  updatedAt: new Date().toISOString(),
  rounds,
  entries,
}, null, 1));
console.log(`ranking: ${entries.length} devices from ${rounds} rounds -> ${OUT}`);
