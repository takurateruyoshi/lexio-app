// main.js — 画面遷移と各モード（ソロ/ホスト/ゲスト）の配線・リロード復帰
"use strict";
import { GameController } from "./game.js";
import { HostSession, GuestSession, STORE_GUEST } from "./net.js";
import { $, renderGame, setActionMessage, selectedTiles, showScreen, buildRulesContent } from "./ui.js";
import { loadModel, getTheta } from "./model.js";
import { saveGameRecord, exportRecordsToFile, countRecords, annotateBlocking } from "./replay.js";

const STORE_SOLO = "lexio.solo.v1";

let session = null;      // {mode:'solo'|'host'|'guest', ...}
let lastView = null;
let reconnecting = null; // ゲスト再接続中の表示用

const playerName = () => ($("player-name").value.trim() || "あなた");
const numRounds = () => Math.max(1, Math.min(99, parseInt($("num-rounds").value, 10) || 1));
const showHistory = () => $("history-toggle").checked;

function rerender() {
  if (lastView) onViewUpdate(lastView);
}

// ---- 上部バナー（一時停止 / 再接続 / 終了提案） ----
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
  }
  b.innerHTML = html;
  b.classList.toggle("hidden", !html);
  const vy = $("vote-yes"), vn = $("vote-no"), fe = $("force-end");
  if (vy) vy.addEventListener("click", () => voteEnd(true));
  if (vn) vn.addEventListener("click", () => voteEnd(false));
  if (fe) fe.addEventListener("click", () => session && session.host && session.host.forceEnd());
}

// 完了したマッチの牌譜を保存（阻害行動アノテーション付き）
function saveMatchRecords(ctrl, mode) {
  const th = getTheta();
  for (const rec of ctrl.records) {
    try { annotateBlocking(rec); } catch {}
    saveGameRecord({
      mode,
      at: new Date().toISOString(),
      model: { gen: th.gen, games: th.games },
      numPlayers: ctrl.cfg.numPlayers,
      totalRounds: ctrl.totalRounds,
      ...rec,
    });
  }
}

function onViewUpdate(view) {
  lastView = view;
  renderGame(view, { showHistory: showHistory() });
  renderBanner(view);
  // ゲストは次ラウンド/再戦をホスト任せにする
  $("result-again").classList.toggle("hidden", session && session.mode === "guest");
  // 人間対局の牌譜保存（マッチ終了時に一度）
  if (session && view.matchOver && !session._recSaved) {
    const ctrl = session.ctrl || (session.host && session.host.controller);
    if (ctrl) { session._recSaved = true; saveMatchRecords(ctrl, session.mode); }
  }
  // ソロは自動保存（リロード復帰用）
  if (session && session.mode === "solo") {
    try {
      if (view.matchOver) localStorage.removeItem(STORE_SOLO);
      else localStorage.setItem(STORE_SOLO, JSON.stringify(session.ctrl.snapshot()));
    } catch {}
  }
  // マッチ終了後はゲストの復帰情報も破棄
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
  toggleSpectateControls(false);
  showScreen("title");
  $("title-hint").textContent = "";
  updateResumeButton();
  updateModelInfo();
}

// ---- ソロ ----
function startSolo() {
  try { localStorage.removeItem(STORE_SOLO); } catch {}
  const n = parseInt($("num-players").value, 10);
  const seats = [{ kind: "human", name: playerName() }];
  for (let i = 1; i < n; i++) seats.push({ kind: "ai", name: `AI-${i}` });
  const ctrl = new GameController(n, seats, numRounds(), () => onViewUpdate(ctrl.view(0)));
  session = { mode: "solo", ctrl };
  showScreen("game");
  onViewUpdate(ctrl.view(0));
  ctrl.advance();
}

function updateResumeButton() {
  const btn = $("resume-btn");
  try {
    const raw = localStorage.getItem(STORE_SOLO);
    if (!raw) { btn.classList.add("hidden"); return; }
    const snap = JSON.parse(raw);
    if (!snap || snap.v !== 1) { btn.classList.add("hidden"); return; }
    btn.textContent = `⏸ 続きから再開（${snap.numPlayers}人戦 R${snap.round}/${snap.totalRounds}）`;
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

// ---- ルーム（ホスト） ----
function hostCallbacks() {
  return {
    onReady: (code) => {
      $("title-hint").textContent = "";
      if (!session.host.inGame) {
        showScreen("lobby");
        $("room-code").textContent = code;
        $("lobby-status").textContent = "参加を待っています…（空席はAIで埋めて開始できます）";
        $("start-room-btn").classList.remove("hidden");
      } else {
        $("room-code").textContent = code;
        showScreen("game");
      }
    },
    onLobby: (seats) => renderLobby(seats, true),
    onState: (view) => {
      if ($("screen-game").classList.contains("hidden")) showScreen("game");
      onViewUpdate(view);
    },
    onError: (msg) => { $("title-hint").textContent = msg; leaveSession(); },
  };
}

function createRoom() {
  $("title-hint").textContent = "接続サーバーに接続中...";
  session = { mode: "host" };
  session.host = new HostSession(playerName(), parseInt($("num-players").value, 10),
                                 numRounds(), hostCallbacks());
}

function resumeHost(resume) {
  $("title-hint").textContent = "部屋を復帰中...";
  session = { mode: "host" };
  session.host = new HostSession(null, 0, 0, hostCallbacks(), resume);
  showScreen("game");
}

// ---- ルーム（ゲスト） ----
function guestCallbacks() {
  return {
    onJoined: ({ seat, token, code }) => {
      $("title-hint").textContent = "";
      reconnecting = null;
      try {
        sessionStorage.setItem(STORE_GUEST, JSON.stringify(
          { code, name: session.guestName, seat, token }));
      } catch {}
      if (!session.guest.started) {
        showScreen("lobby");
        $("room-code").textContent = code;
        $("lobby-status").textContent = "ホストの開始を待っています…";
        $("start-room-btn").classList.add("hidden");
      }
      rerender();
    },
    onLobby: (seats) => renderLobby(seats, false),
    onStart: () => showScreen("game"),
    onState: (view) => {
      reconnecting = null;
      if ($("screen-game").classList.contains("hidden")) showScreen("game");
      onViewUpdate(view);
    },
    onReject: (reason) => setActionMessage(reason),
    onError: (msg) => { $("title-hint").textContent = msg; leaveSession(); },
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

function joinRoom() {
  const code = $("join-code").value.trim().toUpperCase();
  if (code.length < 4) { $("title-hint").textContent = "部屋コードを入力してください"; return; }
  $("title-hint").textContent = "部屋に接続中...";
  session = { mode: "guest", guestName: playerName() };
  session.guest = new GuestSession(session.guestName, code, guestCallbacks());
}

function resumeGuest(saved) {
  $("title-hint").textContent = "対局へ再接続中...";
  session = { mode: "guest", guestName: saved.name };
  reconnecting = 1;
  showScreen("game");
  renderBanner(null);
  session.guest = new GuestSession(saved.name, saved.code, guestCallbacks(),
                                   { seat: saved.seat, token: saved.token });
}

function renderLobby(seats, isHost) {
  const el = $("lobby-seats");
  el.innerHTML = "";
  for (const s of seats) {
    const d = document.createElement("div");
    d.className = "lobby-seat " + s.kind;
    const kindLabel = { human: "ホスト", remote: "参加者", open: "→ AIが入ります" }[s.kind] || "";
    d.innerHTML = `<span class="seat-no">席${s.seat + 1}</span> <b>${s.name}</b> <span class="k">${kindLabel}</span>`;
    el.appendChild(d);
  }
}

// ---- アクション ----
function actor() {
  if (!session) return null;
  if (session.mode === "solo") return {
    play: (t) => session.ctrl.play(0, t),
    pass: () => session.ctrl.pass(0),
  };
  if (session.mode === "host") return { play: (t) => session.host.play(t), pass: () => session.host.pass() };
  return { play: (t) => session.guest.play(t), pass: () => session.guest.pass() };
}

function doPlay() {
  const a = actor();
  if (!a) return;
  const tiles = selectedTiles();
  if (!tiles.length) return;
  const err = a.play(tiles);
  setActionMessage(err);
  if (!err && session.mode === "solo") onViewUpdate(session.ctrl.view(0));
}

function doPass() {
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
    session.gamesDone = 0;   // シリーズを最初から
    startSpectateGame();
  }
}

// ---- AI観戦・記録モード ----
function toggleSpectateControls(on) {
  document.querySelectorAll(".spectate-only").forEach((e) => e.classList.toggle("hidden", !on));
  $("end-btn").classList.toggle("hidden", on);
  $("pass-btn").classList.toggle("hidden", on);
  $("play-btn").classList.toggle("hidden", on);
}

function spectateAiOpts() {
  const o = { minDelayMs: parseInt($("speed-select").value, 10) };
  if (session && session.precise) { o.budgetMs = 1000; o.totalPlayouts = 1600; }
  return o;
}

function startSpectate() {
  const n = parseInt($("num-players").value, 10);
  session = {
    mode: "spectate",
    n,
    rounds: Math.max(1, Math.min(99, parseInt($("num-rounds").value, 10) || 1)),
    gamesTarget: Math.max(1, Math.min(100, parseInt($("num-games").value, 10) || 1)),
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
    `モデル: ${th.gen > 0 ? `世代 ${th.gen}・自己対戦 ${th.games.toLocaleString()} 局で学習済み` : "初期値（学習前）"}` +
    `　｜　保存済み牌譜: ${n} ラウンド`;
}

// ---- 対戦終了の提案 ----
function proposeEnd() {
  if (!session || !lastView || lastView.matchOver) return;
  if (session.mode === "solo") {
    if (confirm("対戦をここで終了しますか？（累計チップで最終順位）")) {
      session.ctrl.endMatch();
      onViewUpdate(session.ctrl.view(0));
    }
  } else if (session.mode === "host") {
    session.host.hostProposeEnd();
  } else {
    session.guest.proposeEnd();
  }
}

function voteEnd(agree) {
  if (!session) return;
  if (session.mode === "host") session.host.hostVote(agree);
  else if (session.mode === "guest") session.guest.voteEnd(agree);
}

// ---- 起動時の自動復帰 ----
function tryAutoResume() {
  const hostSave = HostSession.loadResume();
  if (hostSave) { resumeHost(hostSave); return; }
  const guestSave = GuestSession.loadResume();
  if (guestSave) { resumeGuest(guestSave); return; }
  updateResumeButton();
}

// ---- 配線 ----
window.addEventListener("DOMContentLoaded", () => {
  buildRulesContent();
  loadModel().then(updateModelInfo);
  $("spectate-btn").addEventListener("click", startSpectate);
  $("export-btn").addEventListener("click", async () => {
    const n = await exportRecordsToFile();
    $("title-hint").textContent = `牌譜 ${n} ラウンド分をエクスポートしました`;
  });
  $("reveal-toggle").addEventListener("change", () => onSpectateUpdate());
  $("speed-select").addEventListener("change", () => {
    if (session && session.ctrl) session.ctrl.aiOpts.minDelayMs = parseInt($("speed-select").value, 10);
  });
  $("solo-btn").addEventListener("click", startSolo);
  $("resume-btn").addEventListener("click", resumeSolo);
  $("create-room-btn").addEventListener("click", createRoom);
  $("join-room-btn").addEventListener("click", joinRoom);
  $("start-room-btn").addEventListener("click", () => session && session.host && session.host.startGame());
  $("lobby-leave-btn").addEventListener("click", leaveSession);
  $("copy-code-btn").addEventListener("click", () => {
    navigator.clipboard && navigator.clipboard.writeText($("room-code").textContent);
    $("copy-code-btn").textContent = "コピーしました";
    setTimeout(() => { $("copy-code-btn").textContent = "コピー"; }, 1200);
  });
  $("play-btn").addEventListener("click", doPlay);
  $("pass-btn").addEventListener("click", doPass);
  $("end-btn").addEventListener("click", proposeEnd);
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
  $("drawer-btn").addEventListener("click", () => $("log-drawer").classList.toggle("hidden"));
  $("drawer-close").addEventListener("click", () => $("log-drawer").classList.add("hidden"));
  const openRules = () => $("rules-overlay").classList.remove("hidden");
  $("rules-btn-title").addEventListener("click", openRules);
  $("rules-btn-game").addEventListener("click", openRules);
  $("rules-close").addEventListener("click", () => $("rules-overlay").classList.add("hidden"));

  // 誤リロード防止（対局中のみ）。リロードしても自動復帰はできる。
  window.addEventListener("beforeunload", (e) => {
    if (session && lastView && !lastView.matchOver) e.preventDefault();
  });

  tryAutoResume();
});
