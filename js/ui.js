// ui.js — ビュー(view)の描画。ローカル/リモート共通。雀魂風の全画面卓レイアウト。
"use strict";

const $ = (id) => document.getElementById(id);
export { $ };

let SELECTED = new Set();
export function clearSelection() { SELECTED = new Set(); }
export function selectedTiles() { return [...SELECTED]; }

// cls: "flat"=卓上の表示, "mini"=履歴用小型, "tiny"=アバター下の極小履歴
export function tileEl(t, cls, clickable, onToggle) {
  const d = document.createElement("div");
  d.className = "tile " + t.suit_class + (cls ? " " + cls : "") + (t.joker ? " joker" : "");
  d.innerHTML = `<span class="num">${t.rank}</span><span class="gly">${t.glyph}</span>`;
  d.dataset.id = t.id;
  if (clickable) {
    d.addEventListener("click", () => {
      if (SELECTED.has(t.id)) { SELECTED.delete(t.id); d.classList.remove("selected"); }
      else { SELECTED.add(t.id); d.classList.add("selected"); }
      onToggle && onToggle();
    });
  }
  return d;
}

// 席の配置（自分が常に手前）
function seatPositions(n) {
  switch (n) {
    case 2:  return ["b", "t"];
    case 3:  return ["b", "r", "l"];
    case 4:  return ["b", "r", "t", "l"];
    default: return ["b", "r", "tr", "tl", "l"];
  }
}

const AVATAR_HUES = [42, 205, 350, 130, 275]; // 席ごとのアバター色

function renderTable(view, showHistory) {
  const tb = $("table3d");
  tb.innerHTML = "";
  tb.className = "table3d n" + view.numPlayers;
  const n = view.numPlayers;
  const pos = seatPositions(n);

  const trickByP = {};
  for (const pl of view.trickPlays) {
    (trickByP[pl.player] = trickByP[pl.player] || []).push(pl);
  }

  for (const p of view.players) {
    const visIdx = (p.index - view.yourSeat + n) % n;   // 自席=手前
    const seat = document.createElement("div");
    seat.className = `seat pos-${pos[visIdx]}`
      + (p.isTurn ? " turn" : "") + (p.finished ? " finished" : "");

    const plays = trickByP[p.index] || [];

    // 過去に出した牌（極小・アバターの下）
    let histEl = null;
    if (showHistory) {
      const hist = view.seats[p.index].history;
      const past = hist.slice(0, hist.length - plays.length);
      if (past.length) {
        histEl = document.createElement("div");
        histEl.className = "seat-hist";
        for (const meld of past) {
          const g = document.createElement("div");
          g.className = "hist-meld";
          for (const t of meld) g.appendChild(tileEl(t, "tiny", false));
          histEl.appendChild(g);
        }
      }
    }

    // --- 着席パネル（アバター + 名前 + 持ち点 + 履歴）。自席はパネルなし ---
    if (!p.isYou) {
      const info = document.createElement("div");
      info.className = "seat-info";
      const hue = AVATAR_HUES[p.index % AVATAR_HUES.length];
      info.dataset.seat = p.index;
      info.innerHTML = `
        <div class="avatar" style="--hue:${hue}">
          <span>${(p.name || "?").slice(0, 1)}</span>
          <span class="count-badge">×${p.count}</span>
        </div>
        <div class="id-badge">${p.name}${p.finished ? " 👑" : ""}<b>${p.points}点</b>${view.cardCounts ? `<i>🃏${view.cardCounts[p.index]}</i>` : ""}</div>`;
      if (histEl) info.appendChild(histEl);
      seat.appendChild(info);
    }

    // --- 出牌（現在トリック + パス） ---
    const zone = document.createElement("div");
    zone.className = "seat-zone";

    // 観戦モードの手札公開（自席以外）
    if (view.allHands && !p.isYou && view.allHands[p.index]) {
      const hr = document.createElement("div");
      hr.className = "seat-hand";
      for (const t of view.allHands[p.index]) hr.appendChild(tileEl(t, "mini", false));
      zone.appendChild(hr);
    }

    if (p.isYou && histEl) zone.appendChild(histEl);   // 自席は出牌ゾーン側に極小表示

    const mv = document.createElement("div");
    mv.className = "seat-meld";
    if (plays.length) {
      const latest = plays[plays.length - 1];
      if (view.currentMeld && view.lastPlayerSeat === p.index) mv.classList.add("live");
      for (const t of latest.tiles) mv.appendChild(tileEl(t, "flat", false));
    }
    if (p.passed && view.currentMeld) {
      const pc = document.createElement("div");
      pc.className = "pass-chip";
      pc.textContent = "パス";
      mv.appendChild(pc);
    }
    zone.appendChild(mv);
    seat.appendChild(zone);
    tb.appendChild(seat);
  }
}

// 卓の中央には「最新の手（現在の場の役）」の牌のみを表示（文章なし）
function renderCenter(view) {
  const c = $("center-info");
  c.innerHTML = "";
  if (!view.currentMeld) { c.classList.add("hidden"); return; }
  c.classList.remove("hidden");
  const meld = document.createElement("div");
  meld.className = "ci-meld";
  for (const t of view.currentMeld.tiles) meld.appendChild(tileEl(t, "flat", false));
  c.appendChild(meld);
}

export function renderGame(view, opts = {}) {
  clearSelection();

  // 回戦は左上（テキストは最小限）
  $("round-indicator").textContent = `R ${view.round}/${view.totalRounds}`;
  if (!view.terminal) {
    $("result-panel").classList.add("hidden");
    $("result-chip").classList.add("hidden");
  }

  renderTable(view, opts.showHistory !== false);
  renderCenter(view);

  // 自分のアイコン+名前+持ち点（左下・他席と同じスタイル）
  const me = view.players.find((p) => p.isYou);
  const meHue = AVATAR_HUES[view.yourSeat % AVATAR_HUES.length];
  $("my-info").innerHTML = me ? `
    <div class="avatar" style="--hue:${meHue}"><span>${(me.name || "?").slice(0, 1)}</span></div>
    <div class="id-badge">${me.name}${me.finished ? " 👑" : ""}<b>${me.points}点</b></div>` : "";

  const myTurn = view.yourTurn && !view.terminal;
  const sel = opts.selectableIds || null;   // チュートリアル: 許可牌のみ選択可能
  const mh = $("my-hand");
  mh.classList.toggle("your-turn", myTurn);   // 手番は手牌のグローで伝える
  mh.innerHTML = "";
  for (const t of view.yourHand) {
    const allowed = !sel || sel.has(t.id);
    const el = tileEl(t, "", myTurn && allowed, () => {
      $("play-btn").disabled = SELECTED.size === 0 || !view.yourTurn;
    });
    if (sel) el.classList.add(allowed ? "hint-glow" : "dimmed");
    mh.appendChild(el);
  }

  // ボタンは必要な時だけ出す（パス=左 / 出す=右）
  $("pass-btn").classList.toggle("hidden", !view.canPass);
  $("pass-btn").disabled = !view.canPass;
  $("play-wrap").classList.toggle("hidden", !myTurn);
  $("play-btn").disabled = true;

  if (view.terminal && view.scores) showResult(view);
}

export function showResult(view) {
  $("result-again").classList.remove("hidden");
  $("result-title-btn").classList.remove("hidden");
  const multi = view.totalRounds > 1;
  const tbl = $("result-table");
  tbl.innerHTML = `<tr><th>プレイヤー</th><th>残り</th><th>今回</th><th>持ち点</th></tr>`;
  const sortKey = view.matchOver ? "total" : "score";
  const sorted = [...view.scores].sort((a, b) => b[sortKey] - a[sortKey]);
  for (const s of sorted) {
    const fmt = (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}`;
    const cls = (v) => (v > 0 ? "pos" : (v < 0 ? "neg" : ""));
    const win = s.name === view.winner ? "win" : "";
    tbl.innerHTML += `<tr class="${win}"><td>${s.name}${win ? " 👑" : ""}</td>
      <td>${s.count}</td>
      <td class="${cls(s.score)}">${fmt(s.score)}</td>
      <td>${s.total.toFixed(0)}点</td></tr>`;
  }
  if (view.matchOver) {
    const champ = sorted[0];
    $("result-title").textContent = `🏆 総合優勝: ${champ.name}`;
    $("result-round").textContent = view.winner
      ? `このラウンドの上がり: ${view.winner}`
      : "対戦を終了しました";
  } else {
    $("result-title").textContent = view.winner ? `🏁 ${view.winner} の勝ち！` : "ラウンド終了";
    $("result-round").textContent = multi ? `ラウンド ${view.round} / ${view.totalRounds}` : "";
  }
  $("result-again").textContent = view.matchOver ? "もう一局" : "次のラウンドへ";
  $("result-panel").classList.remove("hidden");
  $("result-chip").classList.add("hidden");
}

// 一局前の結果を結果パネルに表示（対局は継続中・進行ボタンは隠す）
export function showPrevResult(prev) {
  const tbl = $("result-table");
  tbl.innerHTML = `<tr><th>プレイヤー</th><th>今回</th><th>持ち点</th></tr>`;
  const sorted = [...prev.scores].sort((a, b) => b.score - a.score);
  for (const s of sorted) {
    const fmt = (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}`;
    const cls = (v) => (v > 0 ? "pos" : (v < 0 ? "neg" : ""));
    const win = s.name === prev.winner ? "win" : "";
    tbl.innerHTML += `<tr class="${win}"><td>${s.name}${win ? " 👑" : ""}</td>
      <td class="${cls(s.score)}">${fmt(s.score)}</td>
      <td>${s.total === null ? "-" : s.total.toFixed(0) + "点"}</td></tr>`;
  }
  $("result-title").textContent = `前局の結果（R ${prev.round}）`;
  $("result-round").textContent = prev.winner ? `上がり: ${prev.winner}` : "";
  $("result-again").classList.add("hidden");
  $("result-title-btn").classList.add("hidden");
  $("result-panel").classList.remove("hidden");
  $("result-chip").classList.add("hidden");
}

export function setActionMessage(msg) {
  $("action-msg").textContent = msg || "";
}

export function showScreen(name) {
  for (const id of ["screen-title", "screen-setup", "screen-lobby", "screen-game"]) {
    $(id).classList.toggle("hidden", id !== "screen-" + name);
  }
  if (name !== "game") {
    $("result-panel").classList.add("hidden");
    $("result-chip").classList.add("hidden");
    $("net-banner").classList.add("hidden");
  }
}

// ---- ロビー: 対戦画面と同じ卓に着席する表示 ----
export function renderLobbyTable(seats) {
  const tb = $("lobby-seats");
  tb.innerHTML = "";
  const n = seats.length;
  const pos = seatPositions(n);
  for (const s of seats) {
    const el = document.createElement("div");
    el.className = `seat pos-${pos[s.seat]}` + (s.kind === "remote" ? " turn" : "");
    const hue = AVATAR_HUES[s.seat % AVATAR_HUES.length];
    const avatar = s.kind === "open"
      ? `<div class="avatar open-seat"><span>＋</span></div>`
      : s.kind === "ai"
        ? `<div class="avatar" style="--hue:220;filter:grayscale(.4)"><span>🤖</span></div>`
        : `<div class="avatar" style="--hue:${hue}"><span>${(s.name || "?").slice(0, 1)}</span></div>`;
    el.innerHTML = `<div class="seat-info">${avatar}
      <div class="id-badge">${s.kind === "open" ? "募集中" : s.name}</div></div>`;
    tb.appendChild(el);
  }
}

// ---- ルール/チュートリアル共通の牌グラフィック部品 ----
const R_GLYPH = ["☁", "★", "☾", "☀"];
const R_CLASS = ["cloud", "star", "moon", "sun"];
export const rt = (rank, suit) =>
  `<span class="tile rtile ${R_CLASS[suit]}"><span class="num">${rank}</span><span class="gly">${R_GLYPH[suit]}</span></span>`;
export const meldHtml = (pairs) => pairs.map(([r, s]) => rt(r, s)).join("");
const LT = `<span class="rule-sep">&lt;</span>`;

const OK = `<span class="mark-ok">✓</span>`;
const NG = `<span class="mark-ng">✗</span>`;
const ARROW = `<span class="rule-sep">→</span>`;

// ルール画面とチュートリアルで共有する「切り出しスニペット」
export const RULE_SNIPPETS = {
  strength: `<div class="rule-row">${rt(3,0)}${LT}${rt(4,0)}
    <span class="rule-ellipsis">…</span>${LT}${rt(9,0)}${LT}${rt(1,0)}${LT}${rt(2,0)}</div>`,
  suits: `<div class="rule-row">${rt(7,0)}${LT}${rt(7,1)}${LT}${rt(7,2)}${LT}${rt(7,3)}</div>`,
  pair: `<div class="rule-row"><span class="rule-label">ペア</span>${meldHtml([[8,1],[8,3]])}</div>`,
  pass: `<div class="rule-row tut-center"><span class="tut-btn">パス</span>${ARROW}
    ${rt(9,2)}${ARROW}<span class="tut-ok">また出せる</span></div>`,
  one: `<div class="rule-row">${rt(9,1)}${LT}${rt(1,2)}${LT}${rt(2,0)}</div>`,
  two: `<div class="rule-row">${rt(2,0)}${ARROW}<span class="tut-zero">×2</span>
    　${meldHtml([[2,0],[2,1]])}${ARROW}<span class="tut-zero">×4</span></div>`,
  five: `<div class="rule-row">${meldHtml([[5,1],[6,1],[7,0],[8,0],[9,2]])}</div>`,
  settle: `<div class="rule-row tut-center"><span class="tut-zero">0枚</span> 👑
    <span class="rule-sep">vs</span> 残り1枚 ${ARROW}<span class="tut-ok">+1点</span></div>`,
};

export function buildRulesContent() {
  const body = $("rules-body");
  body.innerHTML = `
    <h3>牌の強さ（弱 → 強）</h3>
    ${RULE_SNIPPETS.strength}
    ${RULE_SNIPPETS.suits}

    <h3>役（同じ枚数同士でのみ勝負）</h3>
    <div class="rule-row"><span class="rule-label">単騎</span>${rt(8,2)}
      <span class="rule-label" style="margin-left:18px">ペア</span>${meldHtml([[8,1],[8,3]])}
      <span class="rule-label" style="margin-left:18px">トリプル</span>${meldHtml([[8,0],[8,1],[8,2]])}</div>

    <h3>5枚役（弱 → 強）</h3>
    <div class="rule-row"><span class="rule-label">① ストレート</span>
      ${meldHtml([[4,0],[5,1],[6,2],[7,0],[8,3]])}</div>
    <div class="rule-row"><span class="rule-label">② フラッシュ</span>
      ${meldHtml([[3,2],[5,2],[6,2],[8,2],[9,2]])}</div>
    <div class="rule-row"><span class="rule-label">③ フルハウス</span>
      ${meldHtml([[8,0],[8,1],[8,2],[5,0],[5,3]])}</div>
    <div class="rule-row"><span class="rule-label">④ フォーカード</span>
      ${meldHtml([[6,0],[6,1],[6,2],[6,3],[9,1]])}</div>
    <div class="rule-row"><span class="rule-label">⑤ ストレートフラッシュ</span>
      ${meldHtml([[5,3],[6,3],[7,3],[8,3],[9,3]])}</div>

    <h3>1 と 2 の使い方（ストレート）</h3>
    <div class="rule-row">${OK}${meldHtml([[1,0],[2,1],[3,2],[4,3],[5,0]])}</div>
    <div class="rule-row">${OK}${meldHtml([[6,0],[7,1],[8,2],[9,3],[1,0]])}</div>
    <div class="rule-row">${NG}${meldHtml([[7,0],[8,1],[9,2],[1,3],[2,0]])}</div>
    <div class="tut-caption">1 は頭でも最後でもOK ・ 2 は最後に置けない</div>

    <h3>進行</h3>
    <div class="rule-row tut-center">${rt(5,2)}${ARROW}${rt(8,3)}${ARROW}
      <span class="tut-btn">パス</span>${ARROW}${rt(2,0)}${ARROW}
      <span class="tut-ok">全員パスで場が流れる</span></div>

    <h3>精算</h3>
    <div class="rule-row tut-center"><span class="tut-zero">0枚</span> 👑
      <span class="rule-sep">vs</span>${meldHtml([[5,0],[9,1],[13,2]])}${ARROW}
      <span class="tut-zero">−3点</span>
      　${rt(2,0)}${ARROW}<span class="tut-zero">×2</span></div>
  `;
}
