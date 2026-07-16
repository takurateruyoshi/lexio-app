// main.js — 画面遷移と各モード（ソロ/ホスト/ゲスト）の配線
"use strict";
import { GameController } from "./game.js";
import { HostSession, GuestSession } from "./net.js";
import { $, renderGame, setActionMessage, selectedTiles, showScreen } from "./ui.js";

let session = null;      // {mode:'solo'|'host'|'guest', ...}
let lastView = null;

const playerName = () => ($("player-name").value.trim() || "あなた");
const showHistory = () => $("history-toggle").checked;

function rerender() {
  if (lastView) renderGame(lastView, { showHistory: showHistory() });
}

function onViewUpdate(view) {
  lastView = view;
  renderGame(view, { showHistory: showHistory() });
}

function leaveSession() {
  if (session) {
    if (session.host) session.host.destroy();
    if (session.guest) session.guest.destroy();
  }
  session = null;
  lastView = null;
  showScreen("title");
  $("title-hint").textContent = "";
}

// ---- ソロ ----
function startSolo() {
  const n = parseInt($("num-players").value, 10);
  const seats = [{ kind: "human", name: playerName() }];
  for (let i = 1; i < n; i++) seats.push({ kind: "ai", name: `AI-${i}` });
  const ctrl = new GameController(n, seats, () => onViewUpdate(ctrl.view(0)));
  session = { mode: "solo", ctrl };
  showScreen("game");
  onViewUpdate(ctrl.view(0));
  ctrl.advance();
}

// ---- ルーム（ホスト） ----
function createRoom() {
  const n = parseInt($("num-players").value, 10);
  $("title-hint").textContent = "接続サーバーに接続中...";
  const host = new HostSession(playerName(), n, {
    onReady: (code) => {
      $("title-hint").textContent = "";
      showScreen("lobby");
      $("room-code").textContent = code;
      $("lobby-status").textContent = "参加を待っています…（空席はAIで埋めて開始できます）";
      $("start-room-btn").classList.remove("hidden");
    },
    onLobby: (seats) => renderLobby(seats, true),
    onState: (view) => {
      if (!$("screen-game").classList.contains("hidden") === false) showScreen("game");
      onViewUpdate(view);
    },
    onError: (msg) => { $("title-hint").textContent = msg; leaveSession(); },
  });
  session = { mode: "host", host };
}

// ---- ルーム（ゲスト） ----
function joinRoom() {
  const code = $("join-code").value.trim().toUpperCase();
  if (code.length < 4) { $("title-hint").textContent = "部屋コードを入力してください"; return; }
  $("title-hint").textContent = "部屋に接続中...";
  const guest = new GuestSession(playerName(), code, {
    onJoined: () => {
      $("title-hint").textContent = "";
      showScreen("lobby");
      $("room-code").textContent = code;
      $("lobby-status").textContent = "ホストの開始を待っています…";
      $("start-room-btn").classList.add("hidden");
    },
    onLobby: (seats) => renderLobby(seats, false),
    onStart: () => showScreen("game"),
    onState: (view) => {
      if ($("screen-game").classList.contains("hidden")) showScreen("game");
      onViewUpdate(view);
    },
    onReject: (reason) => setActionMessage(reason),
    onError: (msg) => { $("title-hint").textContent = msg; leaveSession(); },
    onHostLost: () => {
      alert("ホストとの接続が切れました");
      leaveSession();
    },
  });
  session = { mode: "guest", guest };
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
  $("result-overlay").classList.add("hidden");
  if (!session) return;
  if (session.mode === "solo") startSolo();
  else if (session.mode === "host") session.host.rematch();
  // guest はホストの再開を待つ
}

// ---- 配線 ----
window.addEventListener("DOMContentLoaded", () => {
  $("solo-btn").addEventListener("click", startSolo);
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
  $("leave-btn").addEventListener("click", () => {
    if (confirm("ゲームを離れてタイトルに戻りますか？")) leaveSession();
  });
  $("history-toggle").addEventListener("change", rerender);
  $("result-again").addEventListener("click", rematch);
  $("result-title-btn").addEventListener("click", leaveSession);
});
