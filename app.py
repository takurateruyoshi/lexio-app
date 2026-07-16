# -*- coding: utf-8 -*-
"""
app.py — レキシオ Web アプリ (Flask)
============================================
game_cfr_agent.py のエンジン / ベイズモデル / CFR方策を用いて,
人間がブラウザ上で AI と対戦できるようにする。

- 人間は常に seat 0。人数(2〜5)は開始時に選択。
- 各配牌の「最強手プレイヤー」を対象に, 他AIは連携方策で抑制する。
  (対象が人間なら AI 全員が連携して人間を抑えにくる = 研究テーマの体験版)
- AI の意思決定は学習済みポリシー(policies/*.pkl)を読み込む。無ければ
  ヒューリスティックにフォールバックする。
"""
import os
import random
import threading
import uuid
from typing import Dict, List, Optional

from flask import Flask, jsonify, request, send_from_directory

import game_cfr_agent as G

app = Flask(__name__, static_folder="static")

POLICY_DIR = "policies"
SUIT_CLASS = ["cloud", "star", "moon", "sun"]      # CSS 色クラス
SUIT_LABEL = ["雲", "星", "月", "太陽"]
SUIT_GLYPH = ["☁", "★", "☾", "☀"]

# --- ポリシーのキャッシュ(人数ごと) -------------------------------------
_policy_cache: Dict[int, Dict[str, "G.MCCFRTrainer"]] = {}
_policy_lock = threading.Lock()


def get_policies(n: int) -> Dict[str, "G.MCCFRTrainer"]:
    """n人戦の selfish / coalition 方策を取得(なければ即席学習でフォールバック)。"""
    with _policy_lock:
        if n in _policy_cache:
            return _policy_cache[n]
        cfg = G.LexioConfig.standard(n, max_meld_size=5)
        sp = os.path.join(POLICY_DIR, f"selfish_{n}p.pkl")
        cp = os.path.join(POLICY_DIR, f"coalition_{n}p.pkl")
        pols = {}
        if os.path.exists(sp) and os.path.exists(cp):
            pols["selfish"] = G.MCCFRTrainer.load_policy(sp, bayes_samples=25)
            pols["coalition"] = G.MCCFRTrainer.load_policy(cp, bayes_samples=25)
            pols["source"] = "trained"
        else:
            # 未学習: 空の trainer(=ヒューリスティックで動作)
            pols["selfish"] = G.MCCFRTrainer(cfg, seed=1, coalition_mode=False,
                                             bayes_samples=25)
            pols["coalition"] = G.MCCFRTrainer(cfg, seed=2, coalition_mode=True,
                                               coalition_weight=0.75, bayes_samples=25)
            pols["source"] = "heuristic"
        _policy_cache[n] = pols
        return pols


# =============================================================================
# ゲームセッション
# =============================================================================
class Session:
    def __init__(self, num_players: int, human_name: str, seed: Optional[int] = None):
        self.n = num_players
        self.cfg = G.LexioConfig.standard(num_players, max_meld_size=5)
        self.human = 0
        self.names = [human_name.strip() or "あなた"] + \
                     [f"AI-{i}" for i in range(1, num_players)]
        rng = random.Random(seed if seed is not None else random.randrange(1 << 30))
        self.state = G.GameState.deal(self.cfg, rng)
        self.pols = get_policies(num_players)
        self.log: List[dict] = []          # プレイ履歴 + AI思考
        self.trick: List[dict] = []        # 現在のトリックで出た牌 [{player, tiles}]
        self.scores = None                 # 終了時のスコア
        self._note(f"ゲーム開始: {num_players}人戦 / 数字1〜{self.cfg.max_rank} / "
                   f"配牌{self.cfg.hand_size}枚")
        tgt = self.state.target_player
        self._note(f"この配牌の最強手プレイヤー = {self.names[tgt]}"
                   + ("（＝あなたが狙われます！）" if tgt == self.human else ""))
        # 人間が最初のリーダーでなければ AI を進める
        self.advance_ai()

    # --- ログ ---
    def _note(self, msg: str, kind: str = "info", thought: Optional[dict] = None):
        self.log.append({"kind": kind, "msg": msg, "thought": thought})

    # --- AI 意思決定の割り当て ---
    def _agent_for(self, p: int) -> "G.MCCFRTrainer":
        """対象(最強手)プレイヤーには利己的方策, 他は連携方策。"""
        if p == self.state.target_player:
            return self.pols["selfish"]
        return self.pols["coalition"]

    def advance_ai(self):
        """人間の手番/終局まで AI の手番を自動的に進める。"""
        guard = 0
        while (not self.state.is_terminal()
               and self.state.turn != self.human and guard < 500):
            guard += 1
            p = self.state.turn
            agent = self._agent_for(p)
            lab, m, read = agent.act(self.state, p, greedy=False)
            role = "対象(最強手)" if p == self.state.target_player else "連携AI"
            thought = {
                "role": role,
                "is_target": p == self.state.target_player,
                "p_any_opp_beats": round(read.p_any_opp_beats, 2),
                "p_i_strongest": round(read.p_i_strongest, 2),
                "action_label": lab,
            }
            if m is None:
                self._note(f"{self.names[p]} は パス", kind="pass", thought=thought)
            else:
                self._note(f"{self.names[p]} が {meld_text(m)} を出した",
                           kind="play", thought=thought)
                self.trick.append({"player": p, "tiles": list(m.tiles)})
            self.state = self.state.apply(m)
            if self.state.current is None:      # 場が流れた
                self.trick = []
            if m is not None and not self.state.hands[p]:
                self._note(f"🏁 {self.names[p]} が上がりました！", kind="finish")
        if self.state.is_terminal():
            self.finish()

    def human_play(self, tile_ids: List[int]) -> dict:
        """人間が tile_ids のメルドを出す。不正なら error を返す。"""
        if self.state.turn != self.human:
            return {"error": "あなたの手番ではありません"}
        if self.state.is_terminal():
            return {"error": "ゲームは終了しています"}
        hand = self.state.hands[self.human]
        if not all(t in hand for t in tile_ids):
            return {"error": "手札にないタイルが含まれています"}
        meld = G.classify(tile_ids, self.cfg.max_rank)
        if meld is None:
            return {"error": "正当な役ではありません（単/ペア/トリプル/5枚役）"}
        if not G.beats(meld, self.state.current):
            need = "リード可能" if self.state.current is None else \
                   f"場（{meld_text(self.state.current)}）より強い同枚数の役"
            return {"error": f"場に出せません（{need}が必要）"}
        self._note(f"{self.names[self.human]} が {meld_text(meld)} を出した", kind="play")
        self.trick.append({"player": self.human, "tiles": list(meld.tiles)})
        self.state = self.state.apply(meld)
        if self.state.current is None:
            self.trick = []
        if not self.state.hands[self.human]:
            self._note(f"🏁 {self.names[self.human]} が上がりました！", kind="finish")
        self.advance_ai()
        return {"ok": True}

    def human_pass(self) -> dict:
        if self.state.turn != self.human:
            return {"error": "あなたの手番ではありません"}
        if self.state.current is None:
            return {"error": "リード時はパスできません（何か出してください）"}
        self._note(f"{self.names[self.human]} は パス", kind="pass")
        self.state = self.state.apply(None)
        if self.state.current is None:
            self.trick = []
        self.advance_ai()
        return {"ok": True}

    def finish(self):
        if self.scores is None:
            self.scores = G.round_scores(self.state)
            self._note("ゲーム終了。スコアを精算します。", kind="info")

    # --- 人間視点の状態を JSON 化 ---
    def view(self) -> dict:
        st = self.state
        cur = st.current
        legal = []
        my_turn = (st.turn == self.human) and not st.is_terminal()
        if my_turn:
            legal = self._legal_for_human()
        # 対象=最強手プレイヤーのベイズ読み(人間向け表示)
        players = []
        for i in range(self.n):
            players.append({
                "index": i,
                "name": self.names[i],
                "count": len(st.hands[i]),
                "is_turn": (st.turn == i) and not st.is_terminal(),
                "is_target": (i == st.target_player),
                "is_human": (i == self.human),
                "finished": i in st.finished,
            })
        return {
            "num_players": self.n,
            "max_rank": self.cfg.max_rank,
            "your_hand": [tile_json(t, self.cfg.max_rank)
                          for t in sorted(st.hands[self.human],
                                          key=lambda t: G.tile_strength(t, self.cfg.max_rank))],
            "current_meld": None if cur is None else {
                "text": meld_text(cur),
                "tiles": [tile_json(t, self.cfg.max_rank) for t in cur.tiles],
                "size": cur.size,
            },
            "last_player": None if st.last_player < 0 else self.names[st.last_player],
            "leader": self.names[st.leader],
            "turn": st.turn,
            "turn_name": self.names[st.turn] if not st.is_terminal() else None,
            "your_turn": my_turn,
            "can_pass": my_turn and cur is not None,
            "must_lead": my_turn and cur is None,
            "target_player": st.target_player,
            "target_name": self.names[st.target_player],
            "you_are_target": (st.target_player == self.human),
            "players": players,
            "trick_plays": [
                {"player": e["player"],
                 "tiles": [tile_json(t, self.cfg.max_rank) for t in e["tiles"]]}
                for e in self.trick
            ],
            "seats": [
                {"index": i,
                 "history": [[tile_json(t, self.cfg.max_rank) for t in m.tiles]
                             for m in st.played[i]]}
                for i in range(self.n)
            ],
            "legal_hint": legal,
            "log": self.log[-40:],
            "terminal": st.is_terminal(),
            "scores": None if self.scores is None else [
                {"name": self.names[i], "score": float(self.scores[i]),
                 "count": len(st.hands[i]),
                 "twos": sum(1 for t in st.hands[i] if G.tile_rank(t) == 2)}
                for i in range(self.n)
            ],
            "winner": (self.names[st.finished[0]] if st.finished else None),
        }

    def _legal_for_human(self) -> dict:
        """人間UIの補助: どのサイズなら出せるか / パス可否のヒント。"""
        hand = self.state.hands[self.human]
        cur = self.state.current
        info = {"can_pass": cur is not None}
        if cur is None:
            sizes = sorted({m.size for m in G.enumerate_melds(hand, self.cfg)})
            info["lead"] = True
            info["playable_sizes"] = sizes
        else:
            info["lead"] = False
            info["required_size"] = cur.size
            info["has_beating_move"] = G.can_beat(hand, cur, self.cfg)
        return info


def meld_text(m: "G.Meld") -> str:
    return " ".join(f"{SUIT_GLYPH[G.tile_suit(t)]}{G.tile_rank(t)}" for t in m.tiles)


def tile_json(t: int, max_rank: int) -> dict:
    s = G.tile_suit(t)
    return {
        "id": t,
        "rank": G.tile_rank(t),
        "suit": s,
        "suit_class": SUIT_CLASS[s],
        "suit_label": SUIT_LABEL[s],
        "glyph": SUIT_GLYPH[s],
        "strength": G.tile_strength(t, max_rank),
    }


# --- セッション管理 ---
SESSIONS: Dict[str, Session] = {}


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    """style.css / app.js 等を index.html からの相対パスで配信する。"""
    return send_from_directory("static", filename)


@app.route("/api/new_game", methods=["POST"])
def new_game():
    data = request.get_json(force=True)
    n = int(data.get("num_players", 3))
    n = max(2, min(5, n))
    name = str(data.get("human_name", "あなた"))[:20]
    seed = data.get("seed")
    gid = uuid.uuid4().hex[:12]
    SESSIONS[gid] = Session(n, name, seed=seed)
    return jsonify({"game_id": gid, "state": SESSIONS[gid].view()})


@app.route("/api/state")
def get_state():
    gid = request.args.get("game_id", "")
    s = SESSIONS.get(gid)
    if s is None:
        return jsonify({"error": "no such game"}), 404
    return jsonify({"state": s.view()})


@app.route("/api/play", methods=["POST"])
def play():
    data = request.get_json(force=True)
    s = SESSIONS.get(data.get("game_id", ""))
    if s is None:
        return jsonify({"error": "no such game"}), 404
    tiles = [int(t) for t in data.get("tiles", [])]
    res = s.human_play(tiles)
    if "error" in res:
        return jsonify({"error": res["error"], "state": s.view()}), 400
    return jsonify({"state": s.view()})


@app.route("/api/pass", methods=["POST"])
def do_pass():
    data = request.get_json(force=True)
    s = SESSIONS.get(data.get("game_id", ""))
    if s is None:
        return jsonify({"error": "no such game"}), 404
    res = s.human_pass()
    if "error" in res:
        return jsonify({"error": res["error"], "state": s.view()}), 400
    return jsonify({"state": s.view()})


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "policies_cached": list(_policy_cache.keys())})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
