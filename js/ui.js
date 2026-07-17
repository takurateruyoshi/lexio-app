// ui.js — ビュー(view)の描画。ローカル/リモート共通。雀魂風の全画面卓レイアウト。
"use strict";

const $ = (id) => document.getElementById(id);
export { $ };

let SELECTED = new Set();
export function clearSelection() { SELECTED = new Set(); }
export function selectedTiles() { return [...SELECTED]; }

// cls: "flat"=卓上の表示, "mini"=履歴用小型
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

    // --- 着席パネル（アバター + 名前 + 残枚数 + 持ち点）。自席はパネルなし ---
    if (!p.isYou) {
      const info = document.createElement("div");
      info.className = "seat-info";
      const hue = AVATAR_HUES[p.index % AVATAR_HUES.length];
      info.innerHTML = `
        <div class="avatar" style="--hue:${hue}">
          <span>${(p.name || "?").slice(0, 1)}</span>
          <span class="count-badge">×${p.count}</span>
        </div>
        <div class="seat-name">${p.name}${p.finished ? " 👑" : ""}
          <span class="kind-dot ${p.kind === "ai" ? "ai" : "human"}"></span></div>
        <div class="seat-points">${p.points}点</div>`;
      seat.appendChild(info);
    }

    // --- 出牌（現在トリック + 履歴 + パス） ---
    const zone = document.createElement("div");
    zone.className = "seat-zone";
    const plays = trickByP[p.index] || [];

    // 観戦モードの手札公開（自席以外）
    if (view.allHands && !p.isYou && view.allHands[p.index]) {
      const hr = document.createElement("div");
      hr.className = "seat-hand";
      for (const t of view.allHands[p.index]) hr.appendChild(tileEl(t, "mini", false));
      zone.appendChild(hr);
    }

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
        zone.appendChild(hv);
      }
    }

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

  // 自分の名前と持ち点（手牌の左上に小さく）
  const me = view.players.find((p) => p.isYou);
  $("my-info").innerHTML = me
    ? `${me.name}　<b>${me.points}点</b>${me.finished ? " 👑" : ""}` : "";

  const myTurn = view.yourTurn && !view.terminal;
  const mh = $("my-hand");
  mh.classList.toggle("your-turn", myTurn);   // 手番は手牌のグローで伝える
  mh.innerHTML = "";
  for (const t of view.yourHand) {
    mh.appendChild(tileEl(t, "", myTurn, () => {
      $("play-btn").disabled = SELECTED.size === 0 || !view.yourTurn;
    }));
  }

  // ボタンは必要な時だけ出す（パス=左 / 出す=右）
  $("pass-btn").classList.toggle("hidden", !view.canPass);
  $("pass-btn").disabled = !view.canPass;
  $("play-wrap").classList.toggle("hidden", !myTurn);
  $("play-btn").disabled = true;

  if (view.terminal && view.scores) showResult(view);
}

export function showResult(view) {
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

// ---- ルール/チュートリアル共通の牌グラフィック部品 ----
const R_GLYPH = ["☁", "★", "☾", "☀"];
const R_CLASS = ["cloud", "star", "moon", "sun"];
export const rt = (rank, suit) =>
  `<span class="tile rtile ${R_CLASS[suit]}"><span class="num">${rank}</span><span class="gly">${R_GLYPH[suit]}</span></span>`;
export const meldHtml = (pairs) => pairs.map(([r, s]) => rt(r, s)).join("");
const LT = `<span class="rule-sep">&lt;</span>`;

export function buildRulesContent() {
  const body = $("rules-body");
  body.innerHTML = `
    <h3>牌の強さ（弱 → 強）</h3>
    <div class="rule-row">
      ${rt(3,0)}${LT}${rt(4,0)}${LT}${rt(5,0)}
      <span class="rule-ellipsis">…</span>${LT}${rt(9,0)}${LT}${rt(1,0)}${LT}${rt(2,0)}
    </div>
    <p>3 が最弱、<b>1</b> と <b>2</b> は最大数字より強い（<b>2</b> が最強）。</p>
    <div class="rule-row"><span class="rule-label">同じ数字はスートで決着</span>
      ${rt(7,0)}${LT}${rt(7,1)}${LT}${rt(7,2)}${LT}${rt(7,3)}
    </div>

    <h3>役（同じ枚数同士でのみ勝負）</h3>
    <div class="rule-row"><span class="rule-label">単騎（1枚)</span>${rt(8,2)}</div>
    <div class="rule-row"><span class="rule-label">ペア（同数字2枚）</span>${meldHtml([[8,1],[8,3]])}</div>
    <div class="rule-row"><span class="rule-label">トリプル（同数字3枚）</span>${meldHtml([[8,0],[8,1],[8,2]])}</div>

    <h3>5枚役の強さ（弱 → 強）</h3>
    <div class="rule-row"><span class="rule-label">① ストレート</span>
      ${meldHtml([[4,0],[5,1],[6,2],[7,0],[8,3]])}<span class="rule-note">連番5つ</span></div>
    <div class="rule-row"><span class="rule-label">② フラッシュ</span>
      ${meldHtml([[3,2],[5,2],[6,2],[8,2],[9,2]])}<span class="rule-note">同スート5枚</span></div>
    <div class="rule-row"><span class="rule-label">③ フルハウス</span>
      ${meldHtml([[8,0],[8,1],[8,2],[5,0],[5,3]])}<span class="rule-note">3枚+2枚</span></div>
    <div class="rule-row"><span class="rule-label">④ フォーカード</span>
      ${meldHtml([[6,0],[6,1],[6,2],[6,3],[9,1]])}<span class="rule-note">同数字4枚+1枚</span></div>
    <div class="rule-row"><span class="rule-label">⑤ ストレートフラッシュ</span>
      ${meldHtml([[5,3],[6,3],[7,3],[8,3],[9,3]])}<span class="rule-note">連番+同スート</span></div>
    <div class="rule-row"><span class="rule-label">上端をまたぐ形も有効</span>
      ${meldHtml([[6,0],[7,1],[8,2],[9,0],[1,3]])}<span class="rule-sep">／</span>
      ${meldHtml([[7,0],[8,1],[9,2],[1,0],[2,3]])}
    </div>
    <p><b>2</b> を超えて 3 へは続きません（8-9-1-2-3 は不可）。</p>

    <h3>進行</h3>
    <p>リーダーが好きな役を出し、以降は同じ枚数でより強い役を出すか「パス」。
      パスしても、誰かが新しい役を出せばまた出せます。
      全員がパスすると場が流れ、最後に出した人が次のリーダーになります。</p>

    <h3>ラウンド終了と精算</h3>
    <p><b>誰かが手札を出し切った瞬間</b>にラウンド終了。
      全プレイヤーが互いに「残り枚数の差」をチップで支払います。</p>
    <div class="rule-row"><span class="rule-label">支払い倍率</span>
      ${rt(2,0)}<span class="rule-note">が手札に1枚 → ×2</span>
      <span class="rule-sep">／</span>
      ${meldHtml([[2,0],[2,1]])}<span class="rule-note">2枚 → ×4 …</span>
    </div>
    <p>設定したラウンド数を繰り返し、累計チップで総合順位が決まります。
      全員の同意があればその場で対戦を終了できます（累計で最終順位）。</p>
  `;
}
