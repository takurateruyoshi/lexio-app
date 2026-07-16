// ui.js — ビュー(view)の描画。ローカル/リモート共通。
"use strict";

const $ = (id) => document.getElementById(id);
export { $ };

let SELECTED = new Set();
export function clearSelection() { SELECTED = new Set(); }
export function selectedTiles() { return [...SELECTED]; }

// cls: "flat"=卓上に寝かせた表示, "mini"=履歴用小型
export function tileEl(t, cls, clickable, onToggle) {
  const d = document.createElement("div");
  d.className = "tile " + t.suit_class + (cls ? " " + cls : "");
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

function thoughtHtml(th) {
  if (!th) return "";
  const pct = (x) => (x * 100).toFixed(0) + "%";
  const parts = [`勝率 <b>${pct(th.winProb)}</b>`];
  if (th.pSurvive !== null && th.pSurvive !== undefined) {
    parts.push(`この役が通る確率 <b>${pct(th.pSurvive)}</b>`);
  }
  parts.push(`期待収支 <b>${th.evScore >= 0 ? "+" : ""}${th.evScore.toFixed(1)}</b>`);
  return `<div class="th">${parts.join(" ｜ ")}</div>`;
}

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

    const nm = document.createElement("div");
    nm.className = "seat-name";
    nm.textContent = p.name + (p.isYou ? "" : ` ×${p.count}`) + (p.finished ? " 👑" : "");
    seat.appendChild(nm);

    const plays = trickByP[p.index] || [];

    if (showHistory) {
      const hist = view.seats[p.index].history;
      const past = hist.slice(0, hist.length - plays.length);
      if (past.length) {
        const hv = document.createElement("div");
        hv.className = "seat-hist";
        for (const meld of past) {
          const g = document.createElement("div");
          g.className = "hist-meld";
          for (const t of meld) g.appendChild(tileEl(t, "flat mini", false));
          hv.appendChild(g);
        }
        seat.appendChild(hv);
      }
    }

    const mv = document.createElement("div");
    mv.className = "seat-meld";
    if (plays.length) {
      const latest = plays[plays.length - 1];
      if (view.currentMeld && view.lastPlayerSeat === p.index) mv.classList.add("live");
      for (const t of latest.tiles) mv.appendChild(tileEl(t, "flat", false));
    }
    // このトリックでパス済みのプレイヤーには「パス」を表示
    if (p.passed && view.currentMeld) {
      const pc = document.createElement("div");
      pc.className = "pass-chip";
      pc.textContent = "パス";
      mv.appendChild(pc);
    }
    seat.appendChild(mv);
    tb.appendChild(seat);
  }

  const c = document.createElement("div");
  c.className = "table-center";
  c.innerHTML = view.currentMeld
    ? `<b>${view.currentMeld.size}枚役</b><span>を上回れ</span>`
    : `<b>リード</b><span>${view.leader} が自由に出せます</span>`;
  tb.appendChild(c);
}

// handlers: {onToggle, }  opts: {showHistory}
export function renderGame(view, opts = {}) {
  clearSelection();

  $("round-indicator").textContent =
    view.totalRounds > 1 ? `ラウンド ${view.round} / ${view.totalRounds}` : "";
  if (!view.terminal) $("result-overlay").classList.add("hidden");

  // 相手情報ストリップ（AIの直近思考つき）
  const wrap = $("opponents");
  wrap.innerHTML = "";
  const lastThoughtByName = {};
  for (const e of view.log) {
    if (e.thought) {
      const m = e.msg.match(/^(\S+)/);
      if (m) lastThoughtByName[m[1]] = e.thought;
    }
  }
  for (const p of view.players) {
    if (p.isYou) continue;
    const d = document.createElement("div");
    d.className = "opp" + (p.isTurn ? " turn" : "") + (p.finished ? " finished" : "");
    const kindTag = p.kind === "ai" ? `<span class="tag ai">AI</span>`
                                    : `<span class="tag human">プレイヤー</span>`;
    let backs = "";
    for (let i = 0; i < p.count; i++) backs += `<div class="tile-back"></div>`;
    const th = lastThoughtByName[p.name];
    d.innerHTML = `<div class="oname">${p.name} ${kindTag}</div>
      <div class="ocount">手札 ${p.count} 枚 ${p.finished ? "（上がり）" : ""}</div>
      <div class="tile-back-row">${backs}</div>
      ${th ? `<div class="thought">${thoughtHtml(th)}</div>` : ""}`;
    wrap.appendChild(d);
  }

  renderTable(view, opts.showHistory !== false);

  $("board-meta").innerHTML = view.currentMeld
    ? `最後に出した人: <b>${view.lastPlayer || "-"}</b>　｜　リーダー: ${view.leader}`
    : `リーダー: <b>${view.leader}</b> が自由にメルドを出せます`;

  const ti = $("turn-indicator");
  if (view.terminal) { ti.textContent = ""; }
  else if (view.yourTurn) {
    ti.className = "turn-indicator you";
    ti.textContent = view.mustLead ? "▶ あなたの手番（リード：何か出してください）"
                                   : "▶ あなたの手番（出す or パス）";
  } else {
    ti.className = "turn-indicator";
    ti.textContent = `${view.turnName} が思考中...`;
  }

  const mh = $("my-hand");
  mh.innerHTML = "";
  for (const t of view.yourHand) {
    mh.appendChild(tileEl(t, "", view.yourTurn && !view.terminal, () => {
      $("play-btn").disabled = SELECTED.size === 0 || !view.yourTurn;
    }));
  }

  $("pass-btn").disabled = !view.canPass;
  $("play-btn").disabled = true;

  const lg = $("log");
  lg.innerHTML = "";
  for (const e of view.log) {
    const row = document.createElement("div");
    row.className = "row " + (e.kind || "info");
    row.innerHTML = e.msg + thoughtHtml(e.thought);
    lg.appendChild(row);
  }
  lg.scrollTop = lg.scrollHeight;

  if (view.terminal && view.scores) showResult(view);
}

export function showResult(view) {
  const multi = view.totalRounds > 1;
  const tbl = $("result-table");
  tbl.innerHTML = `<tr><th>プレイヤー</th><th>残り</th><th>2の数</th><th>今回</th>${multi ? "<th>累計</th>" : ""}</tr>`;
  const sortKey = view.matchOver && multi ? "total" : "score";
  const sorted = [...view.scores].sort((a, b) => b[sortKey] - a[sortKey]);
  for (const s of sorted) {
    const fmt = (v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}`;
    const cls = (v) => (v > 0 ? "pos" : (v < 0 ? "neg" : ""));
    const win = s.name === view.winner ? "win" : "";
    tbl.innerHTML += `<tr class="${win}"><td>${s.name}${win ? " 👑" : ""}</td>
      <td>${s.count}</td><td>${s.twos}</td>
      <td class="${cls(s.score)}">${fmt(s.score)}</td>
      ${multi ? `<td class="${cls(s.total)}">${fmt(s.total)}</td>` : ""}</tr>`;
  }
  if (view.matchOver && multi) {
    const champ = sorted[0];
    $("result-title").textContent = `🏆 総合優勝: ${champ.name}`;
    $("result-round").textContent = `全 ${view.totalRounds} ラウンド終了（このラウンドの上がり: ${view.winner}）`;
  } else {
    $("result-title").textContent = view.winner ? `🏁 ${view.winner} の勝ち！` : "ラウンド終了";
    $("result-round").textContent = multi ? `ラウンド ${view.round} / ${view.totalRounds}` : "";
  }
  $("result-again").textContent = view.matchOver ? "もう一局" : "次のラウンドへ";
  $("result-overlay").classList.remove("hidden");
}

export function setActionMessage(msg) {
  $("action-msg").textContent = msg || "";
}

export function showScreen(name) {
  for (const id of ["screen-title", "screen-lobby", "screen-game"]) {
    $(id).classList.toggle("hidden", id !== "screen-" + name);
  }
  if (name !== "game") $("result-overlay").classList.add("hidden");
}
