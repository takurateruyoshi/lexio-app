// main.js — 画面遷移と各モードの配線
// フロー: タイトル(続きから/対戦) → 対戦設定(人数・AI席数・ラウンド) → 部屋/ソロ/観戦
"use strict";
import { GameController } from "./game.js";
import { HostSession, GuestSession, STORE_GUEST } from "./net.js";
import { $, renderGame, setActionMessage, selectedTiles, clearSelection, showScreen, buildRulesContent, showPrevResult, renderLobbyTable } from "./ui.js";
import { CARD_DEFS, jokerRankCandidates } from "./cards.js";
import { loadModel, getTheta } from "./model.js";
import { saveGameRecord, exportRecordsToFile, countRecords, annotateBlocking } from "./replay.js";
import { Tutorial } from "./tutorial.js";
import { loadCollectConfig, queueRecord, flushOutbox, flushBeacon, isOptedOut, setOptOut } from "./collect.js";
import { loadNetConfig, getIceServers } from "./netconfig.js";

const STORE_SOLO = "lexio.solo.v1";
const NAME_KEY = "lexio.name";
const SEEN_KEY = "lexio.seen.v1";

let session = null;      // {mode:'solo'|'host'|'guest'|'spectate', ...}
let lastView = null;
let reconnecting = null;
const setup = { size: 3, ai: 0, rule: "classic", rounds: 3, limit: 0, games: 3 };   // 対戦設定の状態
let armedCard = null;   // Neo: 使用準備中のカード {id, rank?, target?, gift?, choices?}
let tutShownKey = null; // チュートリアル: 表示済みステップ
let tutTimer = null;

const storedName = () => { try { return localStorage.getItem(NAME_KEY) || "あなた"; } catch { return "あなた"; } };
const saveName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch {} };
const numRounds = () => Math.max(1, Math.min(99, setup.rounds));
const turnLimit = () => setup.limit;
const showHistory = () => $("history-toggle").checked;

function rerender() { if (lastView) onViewUpdate(lastView); }

// ---- 上部バナー（一時停止 / 再接続 / 終了提案 / 練習ヒント） ----
function renderBanner(view) {
  const b = $("net-banner");
  let html = "";
  if (reconnecting !== null) {
    html = `⏳ ホストへ再接続中… (${reconnecting})`;
  } else if (view && view.endProposal) {
    const ep = view.endProposal;
    if (!ep.youVoted) {
      html = `🛑 <b>${ep.fromName}</b> が対戦終了を提案しています
        <button id="vote-yes" class="primary small">同意して終了</button>
        <button id="vote-no" class="ghost small">続行する</button>`;
    } else {
      html = `🛑 対戦終了の提案中 — 同意待ち: ${ep.waiting.join("・") || "なし"}`;
    }
  } else if (view && view.paused) {
    html = `⏸ ${view.pausedReason || "一時停止中"}`;
    if (session && session.mode === "host") {
      html += ` <button id="force-end" class="ghost small">対戦を終了する</button>`;
    }
  } else if (view && view.endOffer) {
    html = `🃏 精算前に「<b>${view.endOffer.name}</b>」を使いますか？
      <button id="endcard-yes" class="primary small">使う</button>
      <button id="endcard-no" class="ghost small">見送る</button>`;
  } else if (view && view.settling) {
    html = "🃏 他のプレイヤーがスペシャルカードを検討中…";
  }
  const th = $("tut-hint");
  if (!html && session && session.mode === "tutorial" && session.tut) {
    th.innerHTML = session.tut.instructionHtml();
    th.classList.remove("hidden");
    const key = session.tut.done() ? "done" : session.tut.idx;
    if (key !== tutShownKey) {
      // 着手直後は盤面が見えるよう、少し置いてからヒントを出す
      const first = tutShownKey === null;
      tutShownKey = key;
      th.classList.remove("show");
      clearTimeout(tutTimer);
      tutTimer = setTimeout(() => th.classList.add("show"), first ? 0 : 1200);
    }
    // 同一ステップの再レンダーでは何もしない（タイマーが .show を付ける）
  } else {
    th.innerHTML = "";
    th.classList.add("hidden");
    th.classList.remove("show");
    tutShownKey = null;
    clearTimeout(tutTimer);
  }
  b.innerHTML = html;
  b.classList.toggle("hidden", !html);
  const ey = $("endcard-yes"), en = $("endcard-no");
  if (ey) ey.addEventListener("click", () => endCardRespond(true));
  if (en) en.addEventListener("click", () => endCardRespond(false));
  const vy = $("vote-yes"), vn = $("vote-no"), fe = $("force-end");
  if (vy) vy.addEventListener("click", () => voteEnd(true));
  if (vn) vn.addEventListener("click", () => voteEnd(false));
  if (fe) fe.addEventListener("click", () => session && session.host && session.host.forceEnd());
}

// 完了したマッチの牌譜を保存 + 研究用送信キューへ
function saveMatchRecords(ctrl, mode) {
  const th = getTheta();
  for (const rec of ctrl.records) {
    try { annotateBlocking(rec); } catch {}
    const full = {
      mode,
      at: new Date().toISOString(),
      model: { gen: th.gen, games: th.games },
      numPlayers: ctrl.cfg.numPlayers,
      totalRounds: ctrl.totalRounds,
      ...rec,
    };
    saveGameRecord(full);
    queueRecord(full);
  }
  setTimeout(() => flushOutbox(), 1000);
}

function onViewUpdate(view) {
  lastView = view;
  renderGame(view, { showHistory: showHistory() });
  renderBanner(view);
  renderNeoUI(view);
  $("result-again").classList.toggle("hidden", session && session.mode === "guest");
  if (session && view.matchOver && !session._recSaved) {
    const ctrl = session.ctrl || (session.host && session.host.controller);
    if (ctrl) { session._recSaved = true; saveMatchRecords(ctrl, session.practice ? "practice" : session.mode); }
  }
  if (session && session.mode === "solo") {
    try {
      if (view.matchOver || session.practice) localStorage.removeItem(STORE_SOLO);
      else localStorage.setItem(STORE_SOLO, JSON.stringify(session.ctrl.snapshot()));
    } catch {}
  }
  if (session && session.mode === "guest" && view.matchOver) {
    try { sessionStorage.removeItem(STORE_GUEST); } catch {}
  }
}

function leaveSession() {
  if (session) {
    if (session.host) session.host.destroy();
    if (session.guest) session.guest.destroy();
  }
  session = null;
  lastView = null;
  reconnecting = null;
  armedCard = null;
  toggleSpectateControls(false);
  showScreen("title");
  $("title-hint").textContent = "";
  updateResumeButton();
  updateModelInfo();
}

// ============================== 対戦設定 ==============================
function goSetup() {
  showScreen("setup");
  renderSetup();
}

const LIMIT_STEPS = [0, 15, 30, 60];

function stepSetting(k, d) {
  if (k === "size") setup.size = 2 + ((setup.size - 2 + d + 4) % 4);
  else if (k === "ai") setup.ai = (setup.ai + d + setup.size + 1) % (setup.size + 1);
  else if (k === "rule") setup.rule = setup.rule === "classic" ? "neo" : "classic";
  else if (k === "rounds") setup.rounds = Math.max(1, Math.min(99, setup.rounds + d));
  else if (k === "limit") {
    const i = LIMIT_STEPS.indexOf(setup.limit);
    setup.limit = LIMIT_STEPS[(i + d + LIMIT_STEPS.length) % LIMIT_STEPS.length];
  } else if (k === "games") setup.games = Math.max(1, Math.min(100, setup.games + d));
  renderSetup();
}

function renderSetup() {
  if (setup.ai > setup.size) setup.ai = setup.size;
  const remaining = setup.size - setup.ai;   // 人間枠（あなた含む）
  const neoOk = setup.size >= 3 && remaining !== 0;
  if (!neoOk) setup.rule = "classic";
  $("val-size").textContent = `${setup.size}人`;
  $("val-ai").textContent = `${setup.ai}人`;
  $("val-rule").textContent = setup.rule === "neo" ? "Neo" : "クラシック";
  $("val-rounds").textContent = `${setup.rounds}回`;
  $("val-limit").textContent = setup.limit === 0 ? "なし" : `${setup.limit}秒`;
  $("val-games").textContent = `${setup.games}局`;
  $("row-rule").classList.toggle("disabled", !neoOk);
  const preview = $("seat-preview");
  const go = $("setup-go-btn");
  if (remaining === 0) {
    preview.textContent = `全席AI（AI×${setup.size}） — AI同士の対局を観戦・記録します`;
    go.textContent = "観戦を開始 ▶";
  } else if (remaining === 1) {
    preview.textContent = `あなた + AI×${setup.ai} — すぐに対局が始まります`;
    go.textContent = "ソロで開始 ▶";
  } else {
    preview.textContent = `あなた + 募集 ${remaining - 1}人 + AI×${setup.ai}` +
      `（開始時に空いている募集席はAIが埋めます）`;
    go.textContent = "部屋を作る ▶";
  }
  $("row-games").classList.toggle("hidden", remaining !== 0);
  $("precise-row").classList.toggle("hidden", remaining !== 0);
  $("row-limit").classList.toggle("hidden", remaining === 0);
  $("rule-note").textContent = setup.rule === "neo"
    ? "各自スペシャルカード3枚・1ラウンド1枚まで（AIはまだカードを使いません）"
    : (neoOk ? "" : "Neoは3人以上の対人/ソロで選べます");
}

function setupGo() {
  const remaining = setup.size - setup.ai;
  if (remaining === 0) startSpectate();
  else if (remaining === 1) startSolo();
  else createRoom();
}

// ============================== ソロ ==============================
function startSolo() {
  try { localStorage.removeItem(STORE_SOLO); } catch {}
  const n = setup.size;
  const seats = [{ kind: "human", name: storedName() }];
  for (let i = 1; i < n; i++) seats.push({ kind: "ai", name: `AI-${i}` });
  const ctrl = new GameController(n, seats, numRounds(), () => onViewUpdate(ctrl.view(0)),
    { turnLimitSec: turnLimit(), neo: setup.rule === "neo" });
  session = { mode: "solo", ctrl };
  showScreen("game");
  onViewUpdate(ctrl.view(0));
  ctrl.advance();
}

// ============================== チュートリアル（誘導型・固定シナリオ） ==============================
function startTutorial() {
  const tut = new Tutorial((t) => {
    if (!session || session.mode !== "tutorial" || session.tut !== t) return;
    const view = t.view();
    lastView = view;
    renderGame(view, { showHistory: true, selectableIds: t.selectable() });
    renderBanner(view);
    renderNeoUI(view);   // チュートリアルはNeo無効 → カード表示をクリア
    $("pass-btn").classList.toggle("hint-glow", t.expectPass());
    $("result-again").classList.remove("hidden");
    $("result-again").textContent = "もう一度チュートリアル";
  });
  session = { mode: "tutorial", ctrl: tut.ctrl, tut };
  showScreen("game");
  tut.onRender(tut);
}

function updateResumeButton() {
  const btn = $("resume-btn");
  try {
    const raw = localStorage.getItem(STORE_SOLO);
    if (!raw) { btn.classList.add("hidden"); return; }
    const snap = JSON.parse(raw);
    if (!snap || snap.v !== 1) { btn.classList.add("hidden"); return; }
    btn.textContent = `⏸ 続きから（${snap.numPlayers}人戦 R${snap.round}/${snap.totalRounds}）`;
    btn.classList.remove("hidden");
  } catch { btn.classList.add("hidden"); }
}

function resumeSolo() {
  try {
    const snap = JSON.parse(localStorage.getItem(STORE_SOLO));
    if (!snap || snap.v !== 1) return;
    const ctrl = GameController.restore(snap, () => onViewUpdate(ctrl.view(0)));
    session = { mode: "solo", ctrl };
    showScreen("game");
    onViewUpdate(ctrl.view(0));
    ctrl.advance();
  } catch {
    localStorage.removeItem(STORE_SOLO);
    updateResumeButton();
  }
}

// ============================== ルーム（ホスト） ==============================
function hostCallbacks() {
  return {
    onReady: (code) => {
      $("title-hint").textContent = "";
      $("setup-hint").textContent = "";
      $("room-code").textContent = code;
      const link = `${location.origin}${location.pathname}?room=${code}`;
      $("invite-link").value = link;
      $("share-link-btn").classList.toggle("hidden", !navigator.share);
      if (!session.host.inGame) {
        showScreen("lobby");
        $("lobby-status").textContent = "参加を待っています…（今すぐ開始もできます）";
        $("start-room-btn").classList.remove("hidden");
      } else {
        showScreen("game");
      }
    },
    onLobby: (seats) => renderLobby(seats),
    onState: (view) => {
      if ($("screen-game").classList.contains("hidden")) showScreen("game");
      onViewUpdate(view);
    },
    onError: (msg) => {
      // 部屋作成に失敗（オフライン等）→ ソロのフォールバックを提示
      if (session && session.mode === "host" && !session.host.inGame) {
        $("setup-hint").innerHTML = `${msg} — <button id="offline-solo" class="ghost small">オフラインでソロ開始（募集席はAIになります）</button>`;
        showScreen("setup");
        const b = $("offline-solo");
        if (b) b.addEventListener("click", () => startSolo());
        session = null;
      } else {
        $("title-hint").textContent = msg;
        leaveSession();
      }
    },
  };
}

function createRoom() {
  $("setup-hint").textContent = "接続サーバーに接続中...";
  session = { mode: "host" };
  session.host = new HostSession(storedName(), setup.size, numRounds(), hostCallbacks(),
                                 null, { openSeats: setup.size - 1 - setup.ai,
                                         turnLimit: turnLimit(),
                                         neo: setup.rule === "neo" });
}

function resumeHost(resume) {
  session = { mode: "host" };
  session.host = new HostSession(null, 0, 0, hostCallbacks(), resume);
  showScreen("game");
}

// ============================== ルーム（ゲスト） ==============================
function guestCallbacks() {
  return {
    onJoined: ({ seat, token, code }) => {
      $("join-hint").textContent = "";
      $("join-overlay").classList.add("hidden");
      reconnecting = null;
      try {
        sessionStorage.setItem(STORE_GUEST, JSON.stringify(
          { code, name: session.guestName, seat, token }));
      } catch {}
      if (!session.guest.started) {
        showScreen("lobby");
        $("room-code").textContent = code;
        $("invite-link").value = `${location.origin}${location.pathname}?room=${code}`;
        $("lobby-status").textContent = "ホストの開始を待っています…";
        $("start-room-btn").classList.add("hidden");
      }
      rerender();
    },
    onLobby: (seats) => renderLobby(seats),
    onStart: () => showScreen("game"),
    onState: (view) => {
      reconnecting = null;
      if ($("screen-game").classList.contains("hidden")) showScreen("game");
      onViewUpdate(view);
    },
    onReject: (reason) => setActionMessage(reason),
    onProgress: (msg) => { $("join-stage").textContent = msg || ""; },
    onError: (msg) => {
      $("join-stage").textContent = "";
      $("join-hint").textContent = msg;
      $("title-hint").textContent = msg;
    },
    onReconnecting: (attempt) => {
      reconnecting = attempt;
      if ($("screen-game").classList.contains("hidden")) showScreen("game");
      renderBanner(lastView);
    },
    onHostLost: () => {
      alert("ホストとの接続が切れました");
      leaveSession();
    },
  };
}

function showJoinOverlay(code) {
  $("join-code-label").textContent = code.toUpperCase();
  $("join-name").value = storedName();
  $("join-hint").textContent = "";
  $("join-overlay").classList.remove("hidden");
  $("join-go-btn").onclick = () => {
    const name = ($("join-name").value.trim() || "あなた");
    saveName(name);
    $("join-hint").textContent = "部屋に接続中...";
    session = { mode: "guest", guestName: name };
    session.guest = new GuestSession(name, code.toUpperCase(), guestCallbacks());
  };
}

function resumeGuest(saved) {
  session = { mode: "guest", guestName: saved.name };
  reconnecting = 1;
  showScreen("game");
  renderBanner(null);
  session.guest = new GuestSession(saved.name, saved.code, guestCallbacks(),
                                   { seat: saved.seat, token: saved.token });
}

function renderLobby(seats) {
  renderLobbyTable(seats);
  const open = seats.filter((s) => s.kind === "open").length;
  const remote = seats.filter((s) => s.kind === "remote").length;
  $("lobby-status").textContent = remote > 0 || open === 0
    ? `参加者 ${remote}人 — いつでも開始できます（空席はAIが埋めます）`
    : "参加を待っています…（今すぐ開始もできます）";
}

// ============================== 観戦 ==============================
function toggleSpectateControls(on) {
  document.querySelectorAll(".spectate-only").forEach((e) => e.classList.toggle("hidden", !on));
}

function spectateAiOpts() {
  const o = { minDelayMs: parseInt($("speed-select").value, 10) };
  if (session && session.precise) { o.budgetMs = 1000; o.totalPlayouts = 1600; }
  return o;
}

function startSpectate() {
  session = {
    mode: "spectate",
    n: setup.size,
    rounds: numRounds(),
    gamesTarget: Math.max(1, Math.min(100, setup.games)),
    gamesDone: 0,
    precise: $("precise-toggle").checked,
  };
  startSpectateGame();
}

function startSpectateGame() {
  session._recSaved = false;
  const seats = Array.from({ length: session.n }, (_, i) => ({ kind: "ai", name: `AI-${i}` }));
  const ctrl = new GameController(session.n, seats, session.rounds,
    () => onSpectateUpdate(), spectateAiOpts());
  session.ctrl = ctrl;
  showScreen("game");
  toggleSpectateControls(true);
  onSpectateUpdate();
  ctrl.advance();
}

function onSpectateUpdate() {
  if (!session || session.mode !== "spectate") return;
  const ctrl = session.ctrl;
  const view = ctrl.view(0, $("reveal-toggle").checked);
  lastView = view;
  renderGame(view, { showHistory: showHistory() });
  renderNeoUI(view);
  $("round-indicator").textContent =
    `観戦 ${session.gamesDone + 1}/${session.gamesTarget}局　ラウンド ${view.round}/${view.totalRounds}`;
  $("result-again").classList.add("hidden");

  if (view.terminal && !session._advScheduled) {
    session._advScheduled = true;
    setTimeout(() => {
      if (!session || session.mode !== "spectate") return;
      session._advScheduled = false;
      if (!view.matchOver) {
        ctrl.nextRound();
      } else {
        if (!session._recSaved) { session._recSaved = true; saveMatchRecords(ctrl, "spectate"); }
        session.gamesDone++;
        if (session.gamesDone < session.gamesTarget) {
          startSpectateGame();
        } else {
          $("result-again").classList.remove("hidden");
          $("result-again").textContent = "もう一度観戦";
          updateModelInfo();
        }
      }
    }, 1400);
  }
}

async function updateModelInfo() {
  const th = getTheta();
  const n = await countRecords();
  $("model-info").textContent =
    `AIモデル: ${th.gen > 0 ? `世代 ${th.gen}・自己対戦 ${th.games.toLocaleString()} 局で学習` : "初期値"}` +
    `　｜　保存済み牌譜: ${n} ラウンド`;
}

// ============================== アクション ==============================
function actor() {
  if (!session) return null;
  if (session.mode === "solo") return {
    play: (t) => session.ctrl.play(0, t),
    pass: () => session.ctrl.pass(0),
    playCard: (t, c) => session.ctrl.playWithCard(0, t, c),
    newBeginning: () => session.ctrl.useNewBeginning(0),
    endCard: (u) => session.ctrl.respondEnding(0, u),
  };
  if (session.mode === "host") return {
    play: (t) => session.host.play(t), pass: () => session.host.pass(),
    playCard: (t, c) => session.host.playCard(t, c),
    newBeginning: () => session.host.newBeginning(),
    endCard: (u) => session.host.endCard(u),
  };
  if (session.mode === "guest") return {
    play: (t) => session.guest.play(t), pass: () => session.guest.pass(),
    playCard: (t, c) => session.guest.playCard(t, c),
    newBeginning: () => session.guest.newBeginning(),
    endCard: (u) => session.guest.endCard(u),
  };
  return null;
}

function endCardRespond(use) {
  const a = actor();
  if (a && a.endCard) setActionMessage(a.endCard(use));
}

function doPlay() {
  if (session && session.mode === "tutorial") {
    setActionMessage(session.tut.tryPlay(selectedTiles()));
    return;
  }
  const a = actor();
  if (!a) return;
  const tiles = selectedTiles();
  if (armedCard) {
    if (armedCard.id.startsWith("joker") && armedCard.rank == null) {
      if (!tiles.length) { setActionMessage("ジョーカーと一緒に出す牌を選んでください"); return; }
      const cands = jokerRankCandidates(
        tiles, CARD_DEFS[armedCard.id].suit, lastView.numPlayers, lastView.maxRank,
        lastView.currentMeld ? lastView.currentMeld.tiles.map((t) => t.id) : null);
      if (cands.length === 0) { setActionMessage("この牌とジョーカーでは役になりません"); return; }
      if (cands.length === 1) {
        armedCard.rank = cands[0];
      } else {
        armedCard.choices = cands;   // 複数候補 → どの数字として出すか質問
        renderNeoUI(lastView);
        return;
      }
    }
    const need = armedNeeds();
    if (need) { setActionMessage(need); return; }
    const err = a.playCard(tiles, armedCard);
    setActionMessage(err);
    if (!err) armedCard = null;
    if (!err && session.mode === "solo") onViewUpdate(session.ctrl.view(0));
    return;
  }
  if (!tiles.length) return;
  const err = a.play(tiles);
  setActionMessage(err);
  if (!err && session.mode === "solo") onViewUpdate(session.ctrl.view(0));
}

// ---- Neo: スペシャルカードUI ----
function armedNeeds() {
  if (!armedCard) return null;
  if (armedCard.id.startsWith("joker") && armedCard.rank == null) return "どの数字として出すか選んでください";
  if (armedCard.id === "lost_right" && armedCard.target == null) return "対象プレイヤーを選んでください";
  if (armedCard.id === "unwanted_gift") {
    if (armedCard.gift == null) return "贈る牌を1枚タップしてください";
    if (armedCard.target == null) return "渡す相手を選んでください";
  }
  return null;
}

function renderNeoUI(view) {
  const wrap = $("my-cards");
  const ctx = $("card-ctx");
  if (!view || !view.neo || !view.myCards || (session && session.mode === "spectate")) {
    document.querySelectorAll(".seat-info.targetable")
      .forEach((el) => el.classList.remove("targetable"));
    wrap.innerHTML = ""; ctx.classList.add("hidden"); return;
  }
  wrap.innerHTML = "";
  for (const c of view.myCards) {
    const b = document.createElement("button");
    b.className = "ncard art-" + c.id + (armedCard && armedCard.id === c.id ? " armed" : "")
      + (view.cardUsed ? " used" : "");
    b.disabled = view.cardUsed || view.terminal;
    b.innerHTML = `
      <span class="ncard-art">${c.icon}</span>
      <span class="ncard-title"><b>${c.en}</b><i>${c.name}</i></span>
      <span class="ncard-desc">${c.desc}</span>`;
    b.addEventListener("click", () => {
      if (c.id === "new_beginning") {
        if (!view.canNewBeginning) { setActionMessage("配牌直後（最初の牌が出る前）のみ使えます"); return; }
        const a = actor(); setActionMessage(a.newBeginning()); return;
      }
      if (CARD_DEFS_TYPE(c) === "ending") { setActionMessage("精算のタイミングで自動的に確認します"); return; }
      armedCard = (armedCard && armedCard.id === c.id) ? null : { id: c.id };
      if (armedCard && armedCard.id === "unwanted_gift") {
        clearSelection();
        document.querySelectorAll("#my-hand .tile.selected")
          .forEach((t) => t.classList.remove("selected"));
      }
      renderNeoUI(view);
    });
    wrap.appendChild(b);
  }
  positionCardFan();
  // コンテキスト: 対象/渡す牌は盤面から直接タップ。ジョーカーの数字は自動判定
  ctx.innerHTML = "";
  // 対象選択が必要な時だけ相手アバターを光らせる（ギフトは牌を選んでから）
  const needTarget = armedCard && armedCard.target == null &&
    (armedCard.id === "lost_right" ||
     (armedCard.id === "unwanted_gift" && armedCard.gift != null));
  document.querySelectorAll(".seat-info").forEach((el) => {
    el.classList.toggle("targetable", !!needTarget);
  });
  // ギフト牌のマーク（役には使えないので減光）
  document.querySelectorAll(".tile.gift-mark").forEach((el) => {
    el.classList.remove("gift-mark", "gift-hold");
  });
  if (armedCard && armedCard.id === "unwanted_gift" && armedCard.gift != null) {
    const tile = document.querySelector(`#my-hand .tile[data-id="${armedCard.gift}"]`);
    if (tile) { tile.classList.add("gift-mark", "gift-hold"); tile.classList.remove("selected"); }
  }
  if (!armedCard) { ctx.classList.add("hidden"); return; }
  ctx.classList.remove("hidden");
  if (armedCard.id.startsWith("joker")) {
    if (armedCard.choices) {
      ctx.append("どの数字として出す？ ");
      for (const r of armedCard.choices) {
        const b = document.createElement("button");
        b.className = "ghost small";
        b.textContent = String(r);
        b.addEventListener("click", () => {
          armedCard.rank = r;
          delete armedCard.choices;
          doPlay();
        });
        ctx.appendChild(b);
      }
    } else {
      ctx.append("牌を選んで「出す」だけ（数字は自動判定）");
    }
  } else if (armedCard.id === "unwanted_gift" && armedCard.gift == null) {
    ctx.append("👉 贈る牌を1枚タップ");
  } else if (needTarget) {
    ctx.append(armedCard.id === "lost_right"
      ? "👉 強制パスさせる相手のアイコンをタップ"
      : "👉 渡す相手のアイコンをタップ");
  } else {
    ctx.append("あとは出す牌を選んで「出す」");
  }
}

// カード扇を手牌の右端に追従させる
function positionCardFan() {
  const wrap = $("my-cards");
  const tiles = document.querySelectorAll("#my-hand .tile");
  if (!wrap.childElementCount) { wrap.style.left = ""; wrap.style.right = ""; return; }
  if (tiles.length) {
    const r = tiles[tiles.length - 1].getBoundingClientRect();
    const maxLeft = window.innerWidth - 180;
    if (r.right + 10 > maxLeft) {
      // 幅が足りない時は右下コーナーで重ねてコンパクト表示（手牌に被せない）
      wrap.classList.add("stack");
      wrap.style.left = "";
      wrap.style.right = "";
      wrap.style.bottom = "";
    } else {
      wrap.classList.remove("stack");
      wrap.style.left = `${Math.round(r.right + 10)}px`;
      wrap.style.right = "auto";
      wrap.style.bottom = "";
    }
  } else {
    wrap.classList.remove("stack");
    wrap.style.left = "";
    wrap.style.right = "";
    wrap.style.bottom = "";
  }
}
function CARD_DEFS_TYPE(c) { return c.type; }

function doPass() {
  if (session && session.mode === "tutorial") {
    setActionMessage(session.tut.tryPass());
    return;
  }
  const a = actor();
  if (!a) return;
  const err = a.pass();
  setActionMessage(err);
}

function rematch() {
  if (!session) return;
  session._recSaved = false;
  if (session.mode === "solo") {
    if (!session.ctrl.nextRound()) startSolo();
  } else if (session.mode === "host") {
    session.host.advanceMatch();
  } else if (session.mode === "spectate") {
    session.gamesDone = 0;
    startSpectateGame();
  } else if (session.mode === "tutorial") {
    startTutorial();
  }
}

function proposeEnd() {
  if (!session || !lastView || lastView.matchOver) return;
  if (session.mode === "solo") {
    if (confirm("対戦をここで終了しますか？（累計チップで最終順位）")) {
      session.ctrl.endMatch();
      onViewUpdate(session.ctrl.view(0));
    }
  } else if (session.mode === "host") {
    session.host.hostProposeEnd();
  } else if (session.mode === "guest") {
    session.guest.proposeEnd();
  }
}

function voteEnd(agree) {
  if (!session) return;
  if (session.mode === "host") session.host.hostVote(agree);
  else if (session.mode === "guest") session.guest.voteEnd(agree);
}

// ============================== 起動 ==============================
function tryAutoResume() {
  // 招待リンク（?room=CODE）を最優先
  const params = new URLSearchParams(location.search);
  const room = params.get("room");
  if (room && /^[A-Za-z0-9]{4,6}$/.test(room)) {
    history.replaceState({}, "", location.pathname);
    showJoinOverlay(room);
    return;
  }
  const hostSave = HostSession.loadResume();
  if (hostSave) { resumeHost(hostSave); return; }
  const guestSave = GuestSession.loadResume();
  if (guestSave) { resumeGuest(guestSave); return; }
  updateResumeButton();
  // 初回アクセスは誘導型チュートリアルへ
  try {
    if (!localStorage.getItem(SEEN_KEY)) {
      localStorage.setItem(SEEN_KEY, "1");
      startTutorial();
    }
  } catch {}
}

// ---- 接続診断（シグナリング / STUN / TURN） ----
async function runDiagnosis() {
  const set = (id, v) => { $(id).textContent = v; };
  set("diag-sig", "⏳"); set("diag-stun", "⏳"); set("diag-turn", "⏳");
  $("diag-advice").textContent = "テスト中…（数秒かかります）";

  // 1) シグナリング（PeerJSクラウド）
  const sigOk = await new Promise((resolve) => {
    let done = false;
    const p = new Peer({ config: { iceServers: getIceServers() } });
    const fin = (ok) => { if (!done) { done = true; try { p.destroy(); } catch {} resolve(ok); } };
    p.on("open", () => fin(true));
    p.on("error", () => fin(false));
    setTimeout(() => fin(false), 8000);
  });
  set("diag-sig", sigOk ? "✅" : "❌");

  // 2) STUN / TURN（ICE candidate 収集）
  const types = new Set();
  await new Promise((resolve) => {
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: getIceServers() }); }
    catch { resolve(); return; }
    pc.createDataChannel("diag");
    pc.onicecandidate = (e) => {
      if (!e.candidate) { pc.close(); resolve(); return; }
      const m = / typ (\w+)/.exec(e.candidate.candidate);
      if (m) types.add(m[1]);
    };
    pc.createOffer().then((o) => pc.setLocalDescription(o));
    setTimeout(() => { try { pc.close(); } catch {} resolve(); }, 10000);
  });
  const stunOk = types.has("srflx");
  const turnOk = types.has("relay");
  set("diag-stun", stunOk ? "✅" : "❌");
  set("diag-turn", turnOk ? "✅" : "❌");

  let advice;
  if (sigOk && turnOk) advice = "✅ すべて正常です。どのネットワークの相手とも対戦できるはずです。";
  else if (!sigOk) advice = "仲介サーバーに到達できません。Wi-Fi/回線を変えるか、ファイアウォールの設定をご確認ください。";
  else if (!turnOk) advice = "TURN中継に到達できません。厳しいNAT環境の相手（モバイル回線など）とは接続できない場合があります。回線を変えて再テストしてください。";
  else advice = "STUNが取得できませんが、TURN中継があるため対戦は可能です。";
  $("diag-advice").textContent = advice;
}

window.addEventListener("DOMContentLoaded", () => {
  buildRulesContent();
  loadModel().then(updateModelInfo);
  loadNetConfig();   // TURN/STUN 設定（model/net.json）
  loadCollectConfig().then(() => {
    setTimeout(() => flushOutbox(), 5000);
    setInterval(() => flushOutbox(), 60000);   // 未送信分の定期再送
    window.addEventListener("pagehide", flushBeacon);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushBeacon();
    });
  });
  $("diag-btn").addEventListener("click", () => {
    $("diag-overlay").classList.remove("hidden");
    runDiagnosis();
  });
  $("diag-run").addEventListener("click", runDiagnosis);
  $("diag-close").addEventListener("click", () => $("diag-overlay").classList.add("hidden"));

  // タイトル
  $("battle-btn").addEventListener("click", goSetup);
  $("resume-btn").addEventListener("click", resumeSolo);
  $("tutorial-btn").addEventListener("click", startTutorial);
  $("join-room-btn").addEventListener("click", () => {
    const code = $("join-code").value.trim();
    if (code.length < 4) { $("title-hint").textContent = "部屋コードを入力してください"; return; }
    showJoinOverlay(code);
  });
  $("join-cancel-btn").addEventListener("click", () => $("join-overlay").classList.add("hidden"));
  $("export-btn").addEventListener("click", async () => {
    const n = await exportRecordsToFile();
    $("title-hint").textContent = `牌譜 ${n} ラウンド分をエクスポートしました`;
  });
  $("collect-toggle").checked = !isOptedOut();
  $("collect-toggle").addEventListener("change", () => setOptOut(!$("collect-toggle").checked));

  // 対戦設定（ステッパー）
  document.querySelectorAll(".step-btn").forEach((b) => {
    b.addEventListener("click", () => stepSetting(b.dataset.k, parseInt(b.dataset.d, 10)));
  });
  $("setup-go-btn").addEventListener("click", setupGo);
  $("setup-back-btn").addEventListener("click", () => showScreen("title"));

  // ロビー
  $("player-name").value = storedName();
  $("player-name").addEventListener("change", () => {
    const n = ($("player-name").value.trim() || "あなた");
    saveName(n);
    if (session && session.host) session.host.setName(n);
  });
  $("start-room-btn").addEventListener("click", () => session && session.host && session.host.startGame());
  $("lobby-leave-btn").addEventListener("click", leaveSession);
  $("copy-link-btn").addEventListener("click", () => {
    navigator.clipboard && navigator.clipboard.writeText($("invite-link").value);
    $("copy-link-btn").textContent = "コピーしました";
    setTimeout(() => { $("copy-link-btn").textContent = "リンクをコピー"; }, 1200);
  });
  $("share-link-btn").addEventListener("click", () => {
    navigator.share && navigator.share({ title: "レキシオで対戦しよう", url: $("invite-link").value });
  });
  $("copy-code-btn").addEventListener("click", () => {
    navigator.clipboard && navigator.clipboard.writeText($("room-code").textContent);
    $("copy-code-btn").textContent = "コピーしました";
    setTimeout(() => { $("copy-code-btn").textContent = "コードをコピー"; }, 1200);
  });

  // ゲーム内
  $("menu-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("menu-panel").classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".top-menu")) $("menu-panel").classList.add("hidden");
  });
  $("menu-panel").addEventListener("click", (e) => {
    if (e.target.closest("button")) $("menu-panel").classList.add("hidden");
  });
  $("play-btn").addEventListener("click", doPlay);
  $("pass-btn").addEventListener("click", doPass);
  $("prev-btn").addEventListener("click", () => {
    if (lastView && lastView.prevResult) showPrevResult(lastView.prevResult);
    else setActionMessage("まだ前局がありません");
  });
  $("leave-btn").addEventListener("click", () => {
    if (confirm("ゲームを離れてタイトルに戻りますか？")) leaveSession();
  });
  $("history-toggle").addEventListener("change", rerender);
  $("result-again").addEventListener("click", rematch);
  $("result-title-btn").addEventListener("click", leaveSession);
  $("result-hide").addEventListener("click", () => {
    $("result-panel").classList.add("hidden");
    $("result-chip").classList.remove("hidden");
  });
  $("result-chip").addEventListener("click", () => {
    $("result-panel").classList.remove("hidden");
    $("result-chip").classList.add("hidden");
  });
  $("reveal-toggle").addEventListener("change", () => onSpectateUpdate());
  $("speed-select").addEventListener("change", () => {
    if (session && session.ctrl) session.ctrl.aiOpts.minDelayMs = parseInt($("speed-select").value, 10);
  });
  const openRules = () => $("rules-overlay").classList.remove("hidden");
  $("rules-btn-title").addEventListener("click", openRules);
  $("rules-btn-game").addEventListener("click", openRules);
  $("rules-close").addEventListener("click", () => $("rules-overlay").classList.add("hidden"));

  window.addEventListener("beforeunload", (e) => {
    if (session && lastView && !lastView.matchOver && session.mode !== "spectate") e.preventDefault();
  });

  // Neo: 相手アイコン/手牌からの直接選択
  $("table3d").addEventListener("click", (e) => {
    if (!armedCard || armedCard.target != null) return;
    if (armedCard.id !== "lost_right" &&
        !(armedCard.id === "unwanted_gift" && armedCard.gift != null)) return;
    const el = e.target.closest(".seat-info");
    if (!el || el.dataset.seat === undefined) return;
    e.stopPropagation();
    armedCard.target = parseInt(el.dataset.seat, 10);
    if (lastView) renderNeoUI(lastView);
  }, true);
  $("my-hand").addEventListener("click", (e) => {
    if (!(armedCard && armedCard.id === "unwanted_gift")) return;
    const el = e.target.closest(".tile");
    if (!el) return;
    const id = parseInt(el.dataset.id, 10);
    if (armedCard.gift == null) {
      // 贈る牌を1枚だけ選ぶモード（役の選択は後）
      e.stopPropagation();
      e.preventDefault();
      armedCard.gift = id;
      clearSelection();
      document.querySelectorAll("#my-hand .tile.selected")
        .forEach((t) => t.classList.remove("selected"));
      if (lastView) renderNeoUI(lastView);
    } else if (armedCard.gift === id) {
      // ギフト牌をもう一度タップ → 選び直し
      e.stopPropagation();
      e.preventDefault();
      armedCard.gift = null;
      armedCard.target = null;
      if (lastView) renderNeoUI(lastView);
    }
    // それ以外の牌は通常の役選択として素通し
  }, true);
  window.addEventListener("resize", positionCardFan);

  // 思考時間の残りカウントダウン（出すボタンの隣に表示）
  setInterval(() => {
    const tt = $("turn-timer");
    const v = lastView;
    if (v && v.turnDeadline && v.yourTurn && !v.terminal && !v.paused) {
      const secs = Math.max(0, Math.ceil((v.turnDeadline - Date.now()) / 1000));
      tt.textContent = secs;
      tt.classList.remove("hidden");
      tt.classList.toggle("urgent", secs <= 5);
    } else {
      tt.classList.add("hidden");
    }
  }, 250);

  tryAutoResume();
});
