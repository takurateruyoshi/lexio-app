// collect.js — 対局データの研究用送信キュー（二段構え）
// 1) model/collect.json の httpUrl があれば gzip バッチPOST（Cloudflare Worker 等）
// 2) 無ければ/失敗時は P2P 収集ピア（collector.html）へ送信試行
// 送れなかった牌譜は IndexedDB の outbox に残し、次の機会に再送する。
// プレイヤー名は席番号に匿名化される。オプトアウト可（既定ON）。
"use strict";
import { openDb } from "./replay.js";

const OPTOUT_KEY = "lexio.collect.optout";
let CFG = { httpUrl: null, p2pId: "lexio-webapp-collect-1", enabled: true };
let flushing = false;

export function isOptedOut() {
  try { return localStorage.getItem(OPTOUT_KEY) === "1"; } catch { return false; }
}
export function setOptOut(v) {
  try { v ? localStorage.setItem(OPTOUT_KEY, "1") : localStorage.removeItem(OPTOUT_KEY); } catch {}
}

export async function loadCollectConfig(url = "model/collect.json") {
  try {
    const r = await fetch(url, { cache: "no-cache" });
    if (r.ok) CFG = { ...CFG, ...(await r.json()) };
  } catch {}
  return CFG;
}

// 牌譜を匿名化して送信キューに積む
export async function queueRecord(rec) {
  if (isOptedOut() || !CFG.enabled) return;
  const anon = {
    ...rec,
    seats: (rec.seats || []).map((s, i) => ({ kind: s.kind, name: `P${i}` })),
  };
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("outbox", "readwrite");
      tx.objectStore("outbox").add(anon);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {}
}

async function takeBatch(limit = 20) {
  const db = await openDb();
  const items = await new Promise((resolve, reject) => {
    const out = [];
    const rq = db.transaction("outbox", "readonly").objectStore("outbox").openCursor();
    rq.onsuccess = () => {
      const cur = rq.result;
      if (cur && out.length < limit) { out.push({ key: cur.key, value: cur.value }); cur.continue(); }
      else resolve(out);
    };
    rq.onerror = () => reject(rq.error);
  });
  db.close();
  return items;
}

async function deleteKeys(keys) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    for (const k of keys) tx.objectStore("outbox").delete(k);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function outboxCount() {
  try {
    const db = await openDb();
    const n = await new Promise((resolve, reject) => {
      const rq = db.transaction("outbox", "readonly").objectStore("outbox").count();
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    db.close();
    return n;
  } catch { return 0; }
}

async function gzipJson(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === "undefined") return raw;   // fallback: 非圧縮
  const cs = new CompressionStream("gzip");
  const stream = new Blob([raw]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sendHttp(records) {
  const body = await gzipJson({ v: 1, records });
  const r = await fetch(CFG.httpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(typeof CompressionStream !== "undefined" ? { "Content-Encoding": "gzip" } : {}),
    },
    body,
  });
  if (!r.ok) throw new Error("http " + r.status);
}

function sendP2P(records) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { peer.destroy(); } catch {}
      ok ? resolve() : reject(err || new Error("p2p send failed"));
    };
    const timer = setTimeout(() => finish(false, new Error("timeout")), 8000);
    const peer = new Peer();
    peer.on("error", (e) => finish(false, e));
    peer.on("open", () => {
      const conn = peer.connect(CFG.p2pId, { reliable: true });
      conn.on("open", () => conn.send({ t: "games", v: 1, records }));
      conn.on("data", (m) => { if (m && m.t === "ack") finish(true); });
      conn.on("error", (e) => finish(false, e));
      conn.on("close", () => finish(false));
    });
  });
}

// キューの送信を試みる（失敗しても静かに保持し、次の機会に再送）
export async function flushOutbox() {
  if (flushing || isOptedOut() || !CFG.enabled) return;
  flushing = true;
  try {
    const batch = await takeBatch();
    if (!batch.length) return;
    const records = batch.map((b) => b.value);
    if (CFG.httpUrl) {
      try {
        await sendHttp(records);
        await deleteKeys(batch.map((b) => b.key));
        return;
      } catch { /* HTTP失敗 → P2Pへフォールバック */ }
    }
    if (CFG.p2pId && typeof Peer !== "undefined") {
      try {
        await sendP2P(records);
        await deleteKeys(batch.map((b) => b.key));
      } catch { /* 収集ピア不在 — キュー保持 */ }
    }
  } finally {
    flushing = false;
  }
}
