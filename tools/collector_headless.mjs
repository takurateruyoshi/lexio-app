// collector_headless.mjs — GitHub Actions 上で collector.html を headless Chrome で開き、
// P2P で届く牌譜を JSONL として書き出す常駐ドライバ。
//
//   node tools/collector_headless.mjs --minutes 50 --out collected [--git-dir gdata]
//
// 依存: puppeteer-core（CI で npm i --no-save する。リポジトリ本体は npm 不使用のまま）
//       Chrome 本体（環境変数 CHROME_PATH、無ければ既定パスを探す）
// --git-dir を指定すると、書き出し先を git 作業ツリーとみなし、
// 新規レコードがあるたびに commit & push する（クラッシュ時のデータ損失を最小化）。
"use strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(path.join(process.cwd(), "package.json"));
let puppeteer;
try { puppeteer = require("puppeteer-core"); }
catch { console.error("puppeteer-core が見つかりません: npm i --no-save puppeteer-core"); process.exit(1); }

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const MINUTES = Number(arg("minutes", "50"));
const OUT = arg("out", "collected");
const GIT_DIR = arg("git-dir", null);          // 例: gdata（game-data ブランチのworktree）
const URL = arg("url", "https://takurateruyoshi.github.io/lexio-app/collector.html");
const DRAIN_SEC = Number(arg("drain-sec", "300"));
const RUN_ID = process.env.GITHUB_RUN_ID || String(Date.now());

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cands = [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error("Chrome が見つかりません（CHROME_PATH を設定してください）");
}

// IndexedDB lexio-collect/games から lastKey より後のレコードを取り出す
function drainPage(page, lastKey) {
  return page.evaluate(async (lastKey) => {
    const db = await new Promise((res, rej) => {
      const rq = indexedDB.open("lexio-collect", 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore("games", { autoIncrement: true });
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const out = [];
    await new Promise((res, rej) => {
      const range = lastKey != null ? IDBKeyRange.lowerBound(lastKey, true) : null;
      const rq = db.transaction("games", "readonly").objectStore("games").openCursor(range);
      rq.onsuccess = () => {
        const cur = rq.result;
        if (cur && out.length < 2000) { out.push({ key: cur.key, value: cur.value }); cur.continue(); }
        else res();
      };
      rq.onerror = () => rej(rq.error);
    });
    db.close();
    return out;
  }, lastKey);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
}

function commitPush(dir, n) {
  try {
    git(dir, "add", "-A");
    if (git(dir, "status", "--porcelain") === "") return;
    git(dir, "-c", "user.name=lexio-collector[bot]",
        "-c", "user.email=lexio-collector[bot]@users.noreply.github.com",
        "commit", "-m", `collect: +${n} records (run ${RUN_ID})`);
    try { git(dir, "pull", "--rebase", "origin", "game-data"); } catch {}
    git(dir, "push", "origin", "HEAD:game-data");
    console.log(`[git] pushed +${n} records`);
  } catch (e) {
    console.error("[git] commit/push failed:", e.message);
  }
}

const day = () => new Date().toISOString().slice(0, 10);

async function main() {
  const deadline = Date.now() + MINUTES * 60 * 1000;
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage",
           "--autoplay-policy=no-user-gesture-required",
           // WebRTC を headless で確実に有効化
           "--enable-features=WebRTC", "--use-fake-ui-for-media-stream"],
  });
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("[page]", m.text()); });
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
  console.log(`collector open: ${URL} (${MINUTES}min, drain ${DRAIN_SEC}s)`);

  let lastKey = null;
  let total = 0;
  let seq = 0;

  const drainToFile = async () => {
    let batch;
    try {
      batch = await drainPage(page, lastKey);
    } catch (e) {
      console.error("[drain] failed:", e.message);
      return 0;
    }
    if (!batch.length) return 0;
    lastKey = batch[batch.length - 1].key;
    const dir = path.join(OUT, "games", day());
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `run-${RUN_ID}-${seq++}.jsonl`);
    fs.writeFileSync(file, batch.map((b) => JSON.stringify(b.value)).join("\n") + "\n");
    total += batch.length;
    console.log(`[drain] +${batch.length} records -> ${file} (total ${total})`);
    if (GIT_DIR) commitPush(GIT_DIR, batch.length);
    return batch.length;
  };

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(DRAIN_SEC * 1000, Math.max(1000, deadline - Date.now()))));
    await drainToFile();
    // ブローカー切断などでエラー表示になっていたらリロードして再接続
    try {
      const status = await page.$eval("#status", (el) => el.textContent || "");
      if (/エラー/.test(status)) {
        console.log("[peer] error state -> reload");
        await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
      }
    } catch {
      try { await page.reload({ waitUntil: "networkidle2", timeout: 60000 }); } catch {}
    }
  }
  await drainToFile();   // 終了間際の取りこぼし回収
  await browser.close();
  console.log(`done: ${total} records collected`);
}

main().catch((e) => { console.error(e); process.exit(1); });
