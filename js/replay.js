// replay.js — 牌譜の保存（IndexedDB）・エクスポート・阻害行動の事後アノテーション
// アノテーションは記録の解析であり、AIの意思決定には一切影響しない。
"use strict";

const DB_NAME = "lexio";
const STORE = "games";

function openDb() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => {
      if (!rq.result.objectStoreNames.contains(STORE)) {
        rq.result.createObjectStore(STORE, { autoIncrement: true });
      }
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}

export async function saveGameRecord(rec) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).add(rec);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) { console.warn("saveGameRecord failed", e); }
}

export async function getAllRecords() {
  const db = await openDb();
  const recs = await new Promise((resolve, reject) => {
    const rq = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
  db.close();
  return recs;
}

export async function countRecords() {
  try {
    const db = await openDb();
    const n = await new Promise((resolve, reject) => {
      const rq = db.transaction(STORE, "readonly").objectStore(STORE).count();
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    db.close();
    return n;
  } catch { return 0; }
}

export async function clearRecords() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function exportRecordsToFile() {
  const recs = await getAllRecords();
  const blob = new Blob([JSON.stringify(recs, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `lexio-games-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return recs.length;
}

// ---------------------------------------------------------------------------
// 阻害行動の事後検出（観測のみ）:
// リード時に、残り枚数の少ない脅威プレイヤーが「枚数的に追随不能」なサイズを
// 選んだ手（かつ追随可能な候補も存在した）に blocking タグを付ける。
// ---------------------------------------------------------------------------
export function annotateBlocking(roundRec) {
  const events = [];
  for (let mi = 0; mi < roundRec.moves.length; mi++) {
    const mv = roundRec.moves[mi];
    if (!mv.tiles || mv.currentBefore !== null) continue;     // リードのみ
    const size = mv.tiles.length;
    if (size <= 1) continue;
    const threats = [];
    for (let p = 0; p < mv.counts.length; p++) {
      if (p === mv.seat) continue;
      const c = mv.counts[p];
      if (c >= 1 && c <= 2 && c < size) threats.push(p);      // 追随不能な少牌プレイヤー
    }
    if (!threats.length) continue;
    const hadFollowable = mv.thought && mv.thought.candidates &&
      mv.thought.candidates.some((c) => c.size >= 1 && c.size <= Math.max(...threats.map((t) => mv.counts[t])));
    events.push({
      moveIndex: mi,
      seat: mv.seat,
      size,
      threats,
      threatCounts: threats.map((t) => mv.counts[t]),
      hadFollowableAlternative: !!hadFollowable,
      evTable: mv.thought ? mv.thought.candidates : null,
    });
    mv.blocking = { threats, size };
  }
  roundRec.blockingEvents = events;
  return events;
}
