"use strict";
let GAME_ID = null;
let SELECTED = new Set();
let LAST = null;
let SHOW_HISTORY = true;

const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const opt = body
    ? {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)}
    : {};
  const r = await fetch(path, opt);
  const j = await r.json();
  return {ok:r.ok, data:j};
}

// ---- タイル描画 ----
// cls: 追加クラス（"flat"=卓上に寝かせた3D表示, "mini"=履歴用の小型）
function tileEl(t, cls, clickable) {
  const d = document.createElement("div");
  d.className = "tile " + t.suit_class + (cls ? " " + cls : "");
  d.innerHTML = `<span class="num">${t.rank}</span><span class="gly">${t.glyph}</span>`;
  d.dataset.id = t.id;
  if (clickable) {
    d.addEventListener("click", () => {
      if (SELECTED.has(t.id)) { SELECTED.delete(t.id); d.classList.remove("selected"); }
      else { SELECTED.add(t.id); d.classList.add("selected"); }
      updatePlayButton();
    });
  }
  return d;
}

// ---- 席の配置（人間=0 が常に手前） ----
function seatPositions(n) {
  switch (n) {
    case 2:  return ["b", "t"];
    case 3:  return ["b", "r", "l"];
    case 4:  return ["b", "r", "t", "l"];
    default: return ["b", "r", "tr", "tl", "l"];
  }
}

// ---- 開始 ----
async function startGame() {
  const n = parseInt($("num-players").value, 10);
  const name = $("human-name").value;
  SHOW_HISTORY = $("show-history").value === "on";
  $("setup-hint").textContent = "AIを準備中...";
  const {ok, data} = await api("/api/new_game", {num_players:n, human_name:name});
  if (!ok) { $("setup-hint").textContent = "エラー: " + (data.error||""); return; }
  GAME_ID = data.game_id;
  $("setup").classList.add("hidden");
  $("game").classList.remove("hidden");
  render(data.state);
}

// ---- アクション ----
async function playSelected() {
  if (SELECTED.size === 0) return;
  const {ok, data} = await api("/api/play", {game_id:GAME_ID, tiles:[...SELECTED]});
  if (!ok) { $("action-msg").textContent = data.error || "出せません"; }
  else { $("action-msg").textContent = ""; }
  SELECTED.clear();
  render(data.state);
}
async function doPass() {
  const {ok, data} = await api("/api/pass", {game_id:GAME_ID});
  if (!ok) { $("action-msg").textContent = data.error || "パスできません"; }
  else { $("action-msg").textContent = ""; }
  render(data.state);
}

function updatePlayButton() {
  const st = LAST;
  if (!st || !st.your_turn) { $("play-btn").disabled = true; return; }
  $("play-btn").disabled = SELECTED.size === 0;
}

// ---- 卓の描画 ----
function renderTable(st) {
  const tb = $("table3d");
  tb.innerHTML = "";
  tb.className = "table3d n" + st.num_players;
  const pos = seatPositions(st.num_players);

  // 現在のトリックの出牌をプレイヤー別に
  const trickByP = {};
  (st.trick_plays || []).forEach(pl => {
    (trickByP[pl.player] = trickByP[pl.player] || []).push(pl);
  });

  st.players.forEach(p => {
    const seat = document.createElement("div");
    seat.className = `seat pos-${pos[p.index]}`
      + (p.is_turn ? " turn" : "") + (p.is_target ? " target" : "")
      + (p.finished ? " finished" : "");

    const nm = document.createElement("div");
    nm.className = "seat-name";
    nm.textContent = p.name + (p.is_human ? "" : ` ×${p.count}`) + (p.finished ? " 👑" : "");
    seat.appendChild(nm);

    const plays = trickByP[p.index] || [];

    // 過去に出した牌（現在のトリック分は除く）
    if (SHOW_HISTORY) {
      const seatData = (st.seats || []).find(s => s.index === p.index);
      const hist = seatData ? seatData.history : [];
      const past = hist.slice(0, hist.length - plays.length);
      if (past.length) {
        const hv = document.createElement("div");
        hv.className = "seat-hist";
        past.forEach(meld => {
          const g = document.createElement("div");
          g.className = "hist-meld";
          meld.forEach(t => g.appendChild(tileEl(t, "flat mini", false)));
          hv.appendChild(g);
        });
        seat.appendChild(hv);
      }
    }

    // 現在のトリックで出した牌（最新のメルド）
    const mv = document.createElement("div");
    mv.className = "seat-meld";
    if (plays.length) {
      const latest = plays[plays.length - 1];
      if (st.current_meld && st.last_player === p.name) mv.classList.add("live");
      latest.tiles.forEach(t => mv.appendChild(tileEl(t, "flat", false)));
    }
    seat.appendChild(mv);
    tb.appendChild(seat);
  });

  // 中央の状態表示
  const c = document.createElement("div");
  c.className = "table-center";
  c.innerHTML = st.current_meld
    ? `<b>${st.current_meld.size}枚役</b><span>を上回れ</span>`
    : `<b>リード</b><span>${st.leader} が自由に出せます</span>`;
  tb.appendChild(c);
}

// ---- 描画 ----
function render(st) {
  LAST = st;
  SELECTED.clear();

  // target banner
  const tb = $("target-banner");
  if (st.you_are_target) {
    tb.className = "banner you-target";
    tb.innerHTML = `⚠ この配牌の<b>最強手はあなた</b> — AIが連携してあなたを抑えにきます`;
  } else {
    tb.className = "banner ai-target";
    tb.innerHTML = `🎯 抑制ターゲット: <b>${st.target_name}</b>（最強手）— 他AIが連携中`;
  }

  // opponents
  const wrap = $("opponents"); wrap.innerHTML = "";
  st.players.forEach(p => {
    if (p.is_human) return;
    const d = document.createElement("div");
    d.className = "opp" + (p.is_turn?" turn":"") + (p.is_target?" target":"") +
                  (p.finished?" finished":"");
    let tag = p.is_target ? `<span class="tag target">最強手</span>`
                          : `<span class="tag coop">連携AI</span>`;
    let backs = "";
    for (let i=0;i<p.count;i++) backs += `<div class="tile-back"></div>`;
    d.innerHTML = `<div class="oname">${p.name} ${tag}</div>
      <div class="ocount">手札 ${p.count} 枚 ${p.finished?"（上がり）":""}</div>
      <div class="tile-back-row">${backs}</div>
      <div class="thought" data-p="${p.index}"></div>`;
    wrap.appendChild(d);
  });

  // 卓（席ごとの出牌 + 履歴）
  renderTable(st);
  $("board-meta").innerHTML = st.current_meld
    ? `最後に出した人: <b>${st.last_player||"-"}</b>　｜　リーダー: ${st.leader}`
    : `リーダー: <b>${st.leader}</b> が自由にメルドを出せます`;

  // turn indicator
  const ti = $("turn-indicator");
  if (st.terminal) { ti.textContent = ""; }
  else if (st.your_turn) {
    ti.className = "turn-indicator you";
    ti.textContent = st.must_lead ? "▶ あなたの手番（リード：何か出してください）"
                                  : "▶ あなたの手番（出す or パス）";
  } else {
    ti.className = "turn-indicator";
    ti.textContent = `${st.turn_name} が思考中...`;
  }

  // my hand
  const mh = $("my-hand"); mh.innerHTML = "";
  st.your_hand.forEach(t => mh.appendChild(tileEl(t, "", st.your_turn && !st.terminal)));

  $("pass-btn").disabled = !st.can_pass;
  $("play-btn").disabled = true;

  // log (with AI thoughts)
  const lg = $("log"); lg.innerHTML = "";
  st.log.forEach(e => {
    const row = document.createElement("div");
    row.className = "row " + (e.kind||"info");
    let html = e.msg;
    if (e.thought) {
      const th = e.thought;
      html += `<div class="th">${th.role} ｜ 相手が場を上回れる確率
        <b>${(th.p_any_opp_beats*100).toFixed(0)}%</b> ｜ 自分最強
        <b>${(th.p_i_strongest*100).toFixed(0)}%</b> ｜ 判断: ${th.action_label}</div>`;
    }
    row.innerHTML = html;
    lg.appendChild(row);
  });
  lg.scrollTop = lg.scrollHeight;

  // result
  if (st.terminal && st.scores) showResult(st);
}

function showResult(st) {
  const tbl = $("result-table");
  tbl.innerHTML = `<tr><th>プレイヤー</th><th>残り</th><th>2の数</th><th>収支</th></tr>`;
  const sorted = [...st.scores].sort((a,b)=>b.score-a.score);
  sorted.forEach(s => {
    const cls = s.score>0?"pos":(s.score<0?"neg":"");
    const win = s.name===st.winner ? "win":"";
    tbl.innerHTML += `<tr class="${win}"><td>${s.name}${win?" 👑":""}</td>
      <td>${s.count}</td><td>${s.twos}</td>
      <td class="${cls}">${s.score>0?"+":""}${s.score.toFixed(0)}</td></tr>`;
  });
  $("result-title").textContent = st.winner ? `🏁 ${st.winner} の勝ち！` : "ゲーム終了";
  $("result-overlay").classList.remove("hidden");
}

function backToSetup() {
  $("result-overlay").classList.add("hidden");
  $("game").classList.add("hidden");
  $("setup").classList.remove("hidden");
  $("setup-hint").textContent = "";
}

window.addEventListener("DOMContentLoaded", () => {
  $("start-btn").addEventListener("click", startGame);
  $("play-btn").addEventListener("click", playSelected);
  $("pass-btn").addEventListener("click", doPass);
  $("restart-btn").addEventListener("click", backToSetup);
  $("result-again").addEventListener("click", backToSetup);
});
