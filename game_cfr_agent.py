# -*- coding: utf-8 -*-
"""
game_cfr_agent.py
==================
レキシオ (Lexio) 用の統合スクリプト。

要件対応:
  (1) レキシオのルールと盤面管理をコードで定義する          -> LexioConfig / Meld / LexioGame
  (2) 盤面をキーとしたベイズ推定による相手手牌の事後確率     -> BayesianOpponentModel
  (3) CFR(後悔最小化)+ ベイズ読みを意思決定へ統合          -> MCCFRTrainer / infoset_key
  (4) 学習を実行し盤面ごとの最適行動確率を出力              -> main()

研究目的:
  「一番手(手牌が最も良い)プレイヤーを勝たせないために AI 同士が連携する過程」を
  実験できるよう、通常(利己的)ペイオフと連携(coalition)ペイオフを比較する。

  1つの完結したスクリプトとして、実行・自己デバッグして動作させる。
"""

from __future__ import annotations

import itertools
import random
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np


# =============================================================================
# セクション 0: 設定 (人数ごとに数字レンジ・配牌枚数が変わる点を厳密に反映)
# =============================================================================
# 公式ルール (出典: marquand.net/lexio/rules.html - 英語版ルールブックで検証済):
#   「各スートは 1〜15 の最大15枚。人数で使う枚数が変わる。全牌を配りきる。」
#   3人 -> 10〜15 を箱に戻し 1〜9  (36枚 / 3 = 12枚ずつ)
#   4人 -> 14〜15 を箱に戻し 1〜13 (52枚 / 4 = 13枚ずつ)
#   5人 -> 全牌 1〜15            (60枚 / 5 = 12枚ずつ)
#   2人 -> [非公式] 公式は3〜5人戦。ここでは 1〜9 で12枚ずつ配り, 残12枚を
#          伏せ札(未知プール)とする実装上の2人バリアントを採用。
SUIT_NAMES = ["雲", "星", "月", "太陽"]          # 弱 -> 強 (Cloud<Star<Moon<Sun)
SUIT_MARK = ["☁", "★", "☾", "☀"]

# 人数 -> (最大数字, 1人あたり配牌枚数)
PLAYER_CONFIG = {
    2: (9, 12),
    3: (9, 12),
    4: (13, 13),
    5: (15, 12),
}


@dataclass(frozen=True)
class LexioConfig:
    num_players: int
    max_rank: int
    hand_size: int
    max_meld_size: int = 5  # 学習用に 2 (単/ペアのみ) へ縮小可能

    @staticmethod
    def standard(num_players: int, max_meld_size: int = 5) -> "LexioConfig":
        mr, hs = PLAYER_CONFIG[num_players]
        return LexioConfig(num_players, mr, hs, max_meld_size)


# =============================================================================
# セクション 1: 牌と強さの基本表現
# =============================================================================
# 牌 = 整数 ID = rank*4 + suit  (rank:1..max_rank, suit:0..3)
def make_tile(rank: int, suit: int) -> int:
    return rank * 4 + suit


def tile_rank(t: int) -> int:
    return t // 4


def tile_suit(t: int) -> int:
    return t % 4


def rank_strength(rank: int, max_rank: int) -> int:
    """数字の強さ順位: 3<4<...<max<1<2 。3 が最弱(0)、2 が最強。"""
    if rank >= 3:
        return rank - 3            # 3..max -> 0..max-3
    if rank == 1:
        return max_rank - 2        # 1 は max の上
    return max_rank - 1            # 2 が最強


def tile_strength(t: int, max_rank: int) -> int:
    """単牌の総合強さ: 数字強さを主, スート強さを従とする。"""
    return rank_strength(tile_rank(t), max_rank) * 4 + tile_suit(t)


def tile_str(t: int) -> str:
    return f"{SUIT_MARK[tile_suit(t)]}{tile_rank(t)}"


def hand_str(tiles: Sequence[int]) -> str:
    return " ".join(tile_str(t) for t in sorted(tiles))


def full_deck(cfg: LexioConfig) -> List[int]:
    return [make_tile(r, s) for r in range(1, cfg.max_rank + 1) for s in range(4)]


# =============================================================================
# セクション 2: 役 (Meld) の判定と比較
# =============================================================================
# 役カテゴリ (5枚役の強さ: ストレート<フラッシュ<フルハウス<フォーカード<ストレートフラッシュ)
CAT_STRAIGHT = 0
CAT_FLUSH = 1
CAT_FULLHOUSE = 2
CAT_FOURPLUS = 3
CAT_STRAIGHTFLUSH = 4


@dataclass(frozen=True)
class Meld:
    tiles: Tuple[int, ...]        # ソート済み
    size: int                     # 枚数 (1,2,3,5)
    category: int                 # 5枚役のみ意味を持つ (それ以外 -1)
    key: Tuple                    # 同 size 内の全順序比較キー (大きいほど強い)

    def __str__(self) -> str:
        return hand_str(self.tiles)


def _straight_sequences(max_rank: int) -> List[List[int]]:
    """有効なストレートの数字列(強い順)を返す。1 は最上段へのラップのみ許可。"""
    seqs = []
    # 自然な連番 a..a+4 (1..max)。1-2-3-4-5 や 2-3-4-5-6 を含む。
    for a in range(1, max_rank - 3):
        seqs.append([a, a + 1, a + 2, a + 3, a + 4])
    # 上端ラップは「1 で終わる」形のみ (例: 6-7-8-9-1)。2 を最後に置くことはできない。
    seqs.append([max_rank - 3, max_rank - 2, max_rank - 1, max_rank, 1])
    return seqs


def _seq_strength_key(ranks: Sequence[int], max_rank: int) -> Tuple[int, ...]:
    """ストレートの強さ: 構成数字を強さ降順に並べた辞書式キー。
    -> 1,2,3,4,5 が最強, 次に 2,3,4,5,6, 次に 12,13,14,15,1 ... を再現する。"""
    return tuple(sorted((rank_strength(r, max_rank) for r in ranks), reverse=True))


def classify(tiles: Sequence[int], max_rank: int) -> Optional[Meld]:
    """牌集合が正当な役なら Meld を返す。不正なら None。"""
    ts = tuple(sorted(tiles))
    n = len(ts)
    ranks = [tile_rank(t) for t in ts]
    suits = [tile_suit(t) for t in ts]
    rc = Counter(ranks)

    if n == 1:
        return Meld(ts, 1, -1, (tile_strength(ts[0], max_rank),))
    if n == 2:
        if ranks[0] != ranks[1]:
            return None
        strongest = max(ts, key=lambda t: tile_strength(t, max_rank))
        # ペアの強さ = 数字強さ, 同数字なら最強スート
        return Meld(ts, 2, -1,
                    (rank_strength(ranks[0], max_rank), tile_suit(strongest)))
    if n == 3:
        if len(rc) != 1:
            return None
        return Meld(ts, 3, -1, (rank_strength(ranks[0], max_rank),))
    if n == 5:
        # ストレート系判定
        valid_seqs = _straight_sequences(max_rank)
        rankset = sorted(set(ranks))
        is_straight = (len(rc) == 5) and any(sorted(s) == rankset for s in valid_seqs)
        is_flush = (len(set(suits)) == 1)
        seq_for = None
        if is_straight:
            for s in valid_seqs:
                if sorted(s) == rankset:
                    seq_for = s
                    break

        if is_straight and is_flush:
            key = (CAT_STRAIGHTFLUSH,) + _seq_strength_key(seq_for, max_rank) + (suits[0],)
            return Meld(ts, 5, CAT_STRAIGHTFLUSH, key)
        # フォーカード + 1 枚
        counts = sorted(rc.values(), reverse=True)
        if counts == [4, 1]:
            quad_rank = [r for r, c in rc.items() if c == 4][0]
            return Meld(ts, 5, CAT_FOURPLUS,
                        (CAT_FOURPLUS, rank_strength(quad_rank, max_rank)))
        # フルハウス
        if counts == [3, 2]:
            trip_rank = [r for r, c in rc.items() if c == 3][0]
            return Meld(ts, 5, CAT_FULLHOUSE,
                        (CAT_FULLHOUSE, rank_strength(trip_rank, max_rank)))
        # フラッシュ (最大の牌で比較, 同数字ならスート)
        if is_flush:
            top = max(ts, key=lambda t: tile_strength(t, max_rank))
            key = (CAT_FLUSH,) + tuple(
                sorted((tile_strength(t, max_rank) for t in ts), reverse=True))
            return Meld(ts, 5, CAT_FLUSH, key)
        # ストレート (数字列, 同なら最上位牌のスート)
        if is_straight:
            top_rank = max(seq_for, key=lambda r: rank_strength(r, max_rank))
            top_suit = max((tile_suit(t) for t in ts if tile_rank(t) == top_rank))
            key = (CAT_STRAIGHT,) + _seq_strength_key(seq_for, max_rank) + (top_suit,)
            return Meld(ts, 5, CAT_STRAIGHT, key)
        return None
    return None


def beats(cand: Meld, current: Optional[Meld]) -> bool:
    """cand が current より強い(出せる)か。current=None はリード(自由)。"""
    if current is None:
        return True
    if cand.size != current.size:
        return False
    return cand.key > current.key


# =============================================================================
# セクション 3: 合法手の生成
# =============================================================================
def _combos_of_size(tiles: Sequence[int], size: int):
    return itertools.combinations(sorted(tiles), size)


def enumerate_melds(hand: Sequence[int], cfg: LexioConfig,
                    size: Optional[int] = None) -> List[Meld]:
    """手牌から作れる全役を列挙。size 指定時はその枚数のみ。"""
    melds = []
    sizes = [size] if size is not None else [1, 2, 3, 5]
    for sz in sizes:
        if sz > cfg.max_meld_size or sz > len(hand):
            continue
        for c in _combos_of_size(hand, sz):
            m = classify(c, cfg.max_rank)
            if m is not None:
                melds.append(m)
    return melds


def can_beat(hand: Sequence[int], current: Meld, cfg: LexioConfig) -> bool:
    """hand が current を上回る役を 1 つでも作れるか(高速判定・列挙より軽い)。"""
    mr = cfg.max_rank
    sz = current.size
    if sz == 1:
        thr = current.key[0]
        return any(tile_strength(t, mr) > thr for t in hand)
    if sz == 2:
        rc = defaultdict(list)
        for t in hand:
            rc[tile_rank(t)].append(t)
        for r, ts in rc.items():
            if len(ts) >= 2:
                strongest = max(tile_suit(t) for t in ts)
                if (rank_strength(r, mr), strongest) > current.key:
                    return True
        return False
    if sz == 3:
        rc = Counter(tile_rank(t) for t in hand)
        for r, c in rc.items():
            if c >= 3 and (rank_strength(r, mr),) > current.key:
                return True
        return False
    # size 5: 稀なので通常の列挙で判定
    if sz > cfg.max_meld_size:
        return False
    for c in _combos_of_size(hand, 5):
        m = classify(c, mr)
        if m is not None and m.key > current.key:
            return True
    return False


def legal_moves(hand: Sequence[int], current: Optional[Meld],
                cfg: LexioConfig) -> List[Optional[Meld]]:
    """current に対して出せる役 + パス(None)。リード時はパス不可。"""
    if current is None:
        return enumerate_melds(hand, cfg)  # リード: 何か必ず出す
    moves: List[Optional[Meld]] = [None]   # パス
    for m in enumerate_melds(hand, cfg, size=current.size):
        if beats(m, current):
            moves.append(m)
    return moves


# =============================================================================
# セクション 4: 盤面(ゲーム状態)の管理と 1 ラウンドの進行
# =============================================================================
def starting_player(hands: List[List[int]]) -> int:
    """雲(スート0)の 3 を持つプレイヤーが第1ラウンドのリーダー。無ければ最弱牌保持者。"""
    target = make_tile(3, 0)
    for i, h in enumerate(hands):
        if target in h:
            return i
    # 保険: 全体最弱牌の保持者
    best_i, best_v = 0, 10 ** 9
    for i, h in enumerate(hands):
        v = min(tile_rank(t) * 4 + tile_suit(t) for t in h)  # 便宜的
        if v < best_v:
            best_i, best_v = i, v
    return best_i


def hand_strength(hand: Sequence[int], cfg: LexioConfig) -> float:
    """手牌の総合的な強さ指標(大きいほど有利)。
    構成要素: 平均牌強さ + 2/1 の所持 + ペア/役の作りやすさ。"""
    if not hand:
        return 0.0
    mr = cfg.max_rank
    avg = np.mean([tile_strength(t, mr) for t in hand])
    twos = sum(1 for t in hand if tile_rank(t) == 2)
    ones = sum(1 for t in hand if tile_rank(t) == 1)
    rc = Counter(tile_rank(t) for t in hand)
    pairs = sum(1 for c in rc.values() if c >= 2)
    trips = sum(1 for c in rc.values() if c >= 3)
    return float(avg + 3.0 * twos + 1.5 * ones + 0.8 * pairs + 1.5 * trips)


def strongest_hand_player(hands: List[List[int]], cfg: LexioConfig) -> int:
    """この配牌で最も強い手牌を持つ(=一番手が良い)プレイヤーの index。"""
    return int(np.argmax([hand_strength(h, cfg) for h in hands]))


@dataclass
class GameState:
    cfg: LexioConfig
    hands: List[List[int]]                 # 各プレイヤーの手牌
    hidden: List[int]                      # 誰にも配られない伏せ札(2人戦のみ非空)
    current: Optional[Meld] = None         # 場の役
    leader: int = 0                        # 現ラウンドのリーダー(場を制した人)
    turn: int = 0                          # 手番プレイヤー
    passed: List[bool] = field(default_factory=list)  # 現在の場でパス済みか
    last_player: int = -1                  # 直近に役を出した人
    played: List[List[Meld]] = field(default_factory=list)  # 各人の出した履歴
    finished: List[int] = field(default_factory=list)       # 上がり順
    target_player: int = -1   # この配牌で最強手(=抑制対象)のプレイヤー

    @staticmethod
    def deal(cfg: LexioConfig, rng: random.Random,
             fixed_hands: Optional[List[List[int]]] = None) -> "GameState":
        if fixed_hands is not None:
            hands = [list(h) for h in fixed_hands]
            used = {t for h in hands for t in h}
            hidden = [t for t in full_deck(cfg) if t not in used]
        else:
            deck = full_deck(cfg)
            rng.shuffle(deck)
            hands = [sorted(deck[i * cfg.hand_size:(i + 1) * cfg.hand_size])
                     for i in range(cfg.num_players)]
            hidden = deck[cfg.num_players * cfg.hand_size:]
        st = GameState(cfg=cfg, hands=hands, hidden=hidden)
        st.target_player = strongest_hand_player(hands, cfg)
        st.leader = starting_player(hands)
        st.turn = st.leader
        st.passed = [False] * cfg.num_players
        st.played = [[] for _ in range(cfg.num_players)]
        st.finished = []
        return st

    def active_players(self) -> List[int]:
        return [i for i in range(self.cfg.num_players) if self.hands[i]]

    def is_terminal(self) -> bool:
        # 誰かが上がった時点でラウンド終了(即精算)
        return len(self.finished) >= 1 or len(self.active_players()) <= 1

    def clone(self) -> "GameState":
        s = GameState(self.cfg, [list(h) for h in self.hands], list(self.hidden),
                      self.current, self.leader, self.turn, list(self.passed),
                      self.last_player, [list(p) for p in self.played],
                      list(self.finished), self.target_player)
        return s

    def _advance_turn(self):
        """次に手番が来る(上がっておらず, この場でパスしていない)プレイヤーへ。"""
        n = self.cfg.num_players
        for step in range(1, n + 1):
            nxt = (self.turn + step) % n
            if self.hands[nxt] and not self.passed[nxt]:
                self.turn = nxt
                return
        self.turn = self.leader  # 保険

    def _reset_trick(self):
        """全員パス -> 場を流し, 直近に出した人が新しいリードを取る。"""
        self.current = None
        self.leader = self.last_player if self.last_player >= 0 else self.turn
        self.passed = [False] * self.cfg.num_players
        # 既に上がった人はパス扱い
        for i in range(self.cfg.num_players):
            if not self.hands[i]:
                self.passed[i] = True
        self.turn = self.leader
        # リーダーが既に上がっていたら次の生存者へ
        if not self.hands[self.turn]:
            self._advance_turn()

    def apply(self, move: Optional[Meld]) -> "GameState":
        """手番プレイヤーが move を適用した新状態を返す(非破壊)。"""
        s = self.clone()
        p = s.turn
        if move is None:
            s.passed[p] = True
        else:
            for t in move.tiles:
                s.hands[p].remove(t)
            s.current = move
            s.last_player = p
            s.played[p].append(move)
            # パスは「その時点の役への保留」— 新しい役が出たら全員のパスを解除
            s.passed = [not s.hands[i] for i in range(s.cfg.num_players)]
            if not s.hands[p]:                    # 上がり
                s.finished.append(p)
                s.passed[p] = True
        # 場の決着判定: リード以外の全生存者がパス -> リセット
        live = [i for i in range(s.cfg.num_players) if s.hands[i]]
        non_passed = [i for i in live if not s.passed[i]]
        if s.current is not None and len(non_passed) <= 1:
            # 場を制した人(=last_player)が残っていればその人がリード
            if s.hands[s.last_player]:
                s._reset_trick()
            else:
                # 上がってしまった場合, 次の生存者がリード
                s.current = None
                s.passed = [False] * s.cfg.num_players
                for i in range(s.cfg.num_players):
                    if not s.hands[i]:
                        s.passed[i] = True
                s.leader = s.last_player
                s.turn = s.last_player
                s._advance_turn()
                s.leader = s.turn
        else:
            s._advance_turn()
        return s


# ---- レキシオの得点計算 --------------------------------------------------
def round_scores(state: GameState) -> np.ndarray:
    """ラウンド終了時のチップ収支(正=得, 負=損)。
      「上がりが出たら全プレイヤーが互いに, 残り牌枚数の差の額を支払う。
        枚数が多い側が少ない側へ差額を払う。手牌の 2 一枚ごとに支払い倍率が
        ×2 される(1枚=×2, 2枚=×4, ... 倍率 = 2^枚数)。」
    例: 残牌 Bill0/Sally2/Joe5/Ben8 → Bill が全員から受取, Ben が全員へ支払。"""
    cfg = state.cfg
    n = cfg.num_players
    remain = np.array([len(state.hands[i]) for i in range(n)], dtype=float)
    num_two = np.array(
        [sum(1 for t in state.hands[i] if tile_rank(t) == 2) for i in range(n)])
    mult = np.power(2.0, num_two)   # 2 一枚ごとに ×2 (×2, ×4, ...)
    score = np.zeros(n)
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            if remain[i] > remain[j]:
                # i が j へ (差額 × i の倍率) を支払う
                pay = (remain[i] - remain[j]) * mult[i]
                score[i] -= pay
                score[j] += pay
    return score


# =============================================================================
# セクション 5: ベイズ推定による相手手牌の事後確率
# =============================================================================
# 盤面(=自分の手牌+見えている情報)をキーに, 未知牌プールから相手の手を
# モンテカルロで再構成し, 「相手が現在の場を上回れる確率」「自分の手が最強
# である確率」などの事後統計を返す。観測(パス/出した役/残枚数)で条件付ける。
@dataclass
class BayesRead:
    p_opp_can_beat: Dict[int, float]     # 各相手が current を上回れる確率
    p_i_strongest: float                 # 自分が最強手を持つ確率(単牌基準)
    p_any_opp_beats: float               # 誰か 1 人でも上回る確率
    expected_stronger_singles: float     # 自分の最強単牌より強い相手牌の期待枚数
    n_samples: int


class BayesianOpponentModel:
    def __init__(self, cfg: LexioConfig, rng: Optional[random.Random] = None):
        self.cfg = cfg
        self.rng = rng or random.Random(0)
        self._cache: Dict[Tuple, BayesRead] = {}

    def _unknown_pool(self, state: GameState, me: int) -> List[int]:
        """自分から見て位置不明の牌(他家手牌 + 伏せ札)。"""
        seen = set(state.hands[me])
        for i in range(self.cfg.num_players):
            for m in state.played[i]:
                seen.update(m.tiles)
        # 既に出された牌 + 自分の手牌 が既知。残りが未知プール。
        return [t for t in full_deck(self.cfg) if t not in seen]

    def _sample_opponent_hands(self, state: GameState, me: int,
                               pool: List[int]) -> Optional[Dict[int, List[int]]]:
        """未知プールを, 各相手の残枚数に合わせてランダム分割(1 標本)。"""
        counts = {i: len(state.hands[i]) for i in range(self.cfg.num_players)
                  if i != me}
        need = sum(counts.values())
        # 伏せ札の分を除いた残りが相手へ。pool には伏せ札も含まれるため need<=len(pool)
        if need > len(pool):
            return None
        p = pool[:]
        self.rng.shuffle(p)
        out, idx = {}, 0
        for i, c in counts.items():
            out[i] = p[idx:idx + c]
            idx += c
        return out

    def infer(self, state: GameState, me: int, n_samples: int = 200) -> BayesRead:
        cfg = self.cfg
        pool = self._unknown_pool(state, me)
        my_best_single = max(tile_strength(t, cfg.max_rank) for t in state.hands[me]) \
            if state.hands[me] else -1

        opp_ids = [i for i in range(cfg.num_players) if i != me and state.hands[i]]
        beat_counts = {i: 0 for i in opp_ids}
        i_strongest = 0
        any_beat = 0
        stronger_singles_acc = 0.0
        valid = 0

        for _ in range(n_samples):
            sample = self._sample_opponent_hands(state, me, pool)
            if sample is None:
                continue
            valid += 1
            sample_any = False
            # 自分が最強単牌か
            max_opp_single = -1
            stronger = 0
            for i in opp_ids:
                oh = sample[i]
                if not oh:
                    continue
                best_i = max(tile_strength(t, cfg.max_rank) for t in oh)
                max_opp_single = max(max_opp_single, best_i)
                stronger += sum(1 for t in oh
                                if tile_strength(t, cfg.max_rank) > my_best_single)
                # current を上回れるか (高速 can_beat)
                if state.current is not None:
                    if can_beat(oh, state.current, cfg):
                        beat_counts[i] += 1
                        sample_any = True
                else:
                    # リード状況では「自分の最強単牌を上回る単牌を持つ」で近似
                    if best_i > my_best_single:
                        beat_counts[i] += 1
                        sample_any = True
            if max_opp_single <= my_best_single:
                i_strongest += 1
            if sample_any:
                any_beat += 1
            stronger_singles_acc += stronger

        if valid == 0:
            return BayesRead({i: 0.0 for i in opp_ids}, 1.0, 0.0, 0.0, 0)
        read = BayesRead(
            p_opp_can_beat={i: beat_counts[i] / valid for i in opp_ids},
            p_i_strongest=i_strongest / valid,
            p_any_opp_beats=any_beat / valid,
            expected_stronger_singles=stronger_singles_acc / valid,
            n_samples=valid,
        )
        return read


# =============================================================================
# セクション 6: 行動抽象化 と 情報集合キー
# =============================================================================
# 生の役は膨大なので, CFR 用に行動を抽象クラスへまとめる。
#   PASS, LEAD_LOW/LEAD_HIGH(リード時), PLAY_MIN/PLAY_STRONG(応手時) 等。
ACTIONS = ["PASS", "PLAY_MIN", "PLAY_STRONG", "PLAY_SAVE2"]
LEAD_ACTIONS = ["LEAD_SINGLE_LOW", "LEAD_SINGLE_HIGH", "LEAD_COMBO"]


def _bucket(x: float, edges=(0.15, 0.4, 0.7, 0.9)) -> int:
    b = 0
    for e in edges:
        if x >= e:
            b += 1
    return b


def infoset_key(state: GameState, me: int, read: BayesRead, cfg: LexioConfig) -> str:
    """盤面 + ベイズ読み を離散化した情報集合キー。
    CFR の戦略はこのキー単位で学習される(要件2の検索結果を意思決定へ統合)。"""
    hand = state.hands[me]
    nrem = len(hand)
    nrem_b = min(nrem, 6)
    has2 = int(any(tile_rank(t) == 2 for t in hand))
    lead = int(state.current is None)
    cur_size = 0 if state.current is None else state.current.size
    # ベイズ由来の特徴 (相手が上回れる確率 / 自分最強確率)
    b_any = _bucket(read.p_any_opp_beats)
    b_str = _bucket(read.p_i_strongest)
    n_active = len(state.active_players())
    am_t = int(state.target_player == me)   # 自分が抑制対象(最強手)か
    return (f"L{lead}|cs{cur_size}|nr{nrem_b}|h2{has2}|na{n_active}"
            f"|ba{b_any}|bs{b_str}|t{am_t}")


def abstract_actions(state: GameState, me: int, cfg: LexioConfig
                     ) -> List[Tuple[str, Optional[Meld]]]:
    """現盤面での(抽象行動ラベル, 具体的 Meld)候補を返す。"""
    hand = state.hands[me]
    moves = legal_moves(hand, state.current, cfg)
    concrete = [m for m in moves if m is not None]
    out: List[Tuple[str, Optional[Meld]]] = []

    def two_safe(m: Meld) -> bool:
        return not any(tile_rank(t) == 2 for t in m.tiles)

    if state.current is None:
        # リード: 単牌(弱/強) と 複数枚役
        singles = sorted([m for m in concrete if m.size == 1],
                         key=lambda m: m.key)
        combos = [m for m in concrete if m.size >= 2]
        if singles:
            out.append(("LEAD_SINGLE_LOW", singles[0]))
            out.append(("LEAD_SINGLE_HIGH", singles[-1]))
        if combos:
            # 最小枚数×最弱を代表に(手数を早く減らす)
            combos_sorted = sorted(combos, key=lambda m: (m.size, m.key))
            out.append(("LEAD_COMBO", combos_sorted[0]))
        if not out and concrete:
            out.append(("LEAD_SINGLE_LOW", concrete[0]))
    else:
        out.append(("PASS", None))
        if concrete:
            by_key = sorted(concrete, key=lambda m: m.key)
            out.append(("PLAY_MIN", by_key[0]))       # 最小限に勝つ
            out.append(("PLAY_STRONG", by_key[-1]))   # 強く被せる
            safe = [m for m in by_key if two_safe(m)]
            if safe and safe[0] is not by_key[0]:
                out.append(("PLAY_SAVE2", safe[0]))    # 2 を温存して出す
    # 重複ラベル除去(同 Meld)
    seen, uniq = set(), []
    for lab, m in out:
        sig = (lab, None if m is None else m.tiles)
        if sig not in seen:
            seen.add(sig)
            uniq.append((lab, m))
    return uniq


# =============================================================================
# セクション 7: Regret-Matching ノード と MCCFR
# =============================================================================
class Node:
    __slots__ = ("regret", "strategy_sum", "labels")

    def __init__(self, labels: List[str]):
        self.labels = labels
        self.regret = np.zeros(len(labels))
        self.strategy_sum = np.zeros(len(labels))

    def strategy(self) -> np.ndarray:
        pos = np.maximum(self.regret, 0.0)
        s = pos.sum()
        if s > 0:
            return pos / s
        return np.ones(len(self.labels)) / len(self.labels)

    def average_strategy(self) -> np.ndarray:
        s = self.strategy_sum.sum()
        if s > 0:
            return self.strategy_sum / s
        return np.ones(len(self.labels)) / len(self.labels)


class MCCFRTrainer:
    """External-Sampling MCCFR。
    coalition_target が指定されると, そのプレイヤー(=一番手が良い人)を
    勝たせないための連携ペイオフを非対象プレイヤーへ与える。"""

    def __init__(self, cfg: LexioConfig, seed: int = 0,
                 coalition_mode: bool = False,
                 coalition_weight: float = 0.6,
                 bayes_samples: int = 60):
        self.cfg = cfg
        self.rng = random.Random(seed)
        self.nprng = np.random.default_rng(seed)
        self.nodes: Dict[str, Node] = {}
        self.bayes = BayesianOpponentModel(cfg, random.Random(seed + 7))
        self.coalition_mode = coalition_mode
        self.coalition_weight = coalition_weight
        self.bayes_samples = bayes_samples
        self.max_depth = 80
        self._read_cache: Dict[Tuple, BayesRead] = {}

    def _read(self, state: GameState, p: int) -> BayesRead:
        """同一軌跡内でのベイズ読みをキャッシュ(盤面署名で共有)。"""
        sig = (p, tuple(state.hands[p]),
               None if state.current is None else state.current.key,
               tuple(len(h) for h in state.hands))
        r = self._read_cache.get(sig)
        if r is None:
            r = self.bayes.infer(state, p, n_samples=self.bayes_samples)
            self._read_cache[sig] = r
        return r

    # --- ペイオフ整形 ---------------------------------------------------
    def _payoffs(self, state: GameState) -> np.ndarray:
        base = round_scores(state)
        if not self.coalition_mode:
            return base
        # 連携ペイオフ: この配牌で最強手(=一番手が良い)のプレイヤーを対象とし,
        # 対象を勝たせない(得点を抑える)ほど非対象プレイヤーの効用が上がる。
        tgt = state.target_player
        if tgt < 0:
            return base
        shaped = base.copy().astype(float)
        w = self.coalition_weight
        for i in range(self.cfg.num_players):
            if i == tgt:
                continue
            # 自分の素点 と 「対象の抑制(=-base[tgt])」の加重和
            shaped[i] = (1 - w) * base[i] + w * (-base[tgt])
        return shaped

    def _node(self, key: str, labels: List[str]) -> Node:
        nd = self.nodes.get(key)
        if nd is None or nd.labels != labels:
            if nd is None:
                nd = Node(labels)
                self.nodes[key] = nd
            else:
                # ラベル集合が違う場合はキーを細分化
                key2 = key + "|" + ",".join(labels)
                nd = self.nodes.get(key2)
                if nd is None:
                    nd = Node(labels)
                    self.nodes[key2] = nd
        return nd

    def _walk(self, state: GameState, traverser: int, depth: int,
              reach_tr: float, reach_others: float, sample_reach: float
              ) -> float:
        """Outcome-Sampling MCCFR。1 反復で 1 本の軌跡のみを辿るため O(depth)。
        traverser の各情報集合で全行動の反実仮想利得をサンプリング推定し, 他家は
        現在戦略でサンプリングする。戻り値は traverser の(重み付き)サンプル利得。"""
        if state.is_terminal() or depth > self.max_depth:
            return self._payoffs(state)[traverser] / max(sample_reach, 1e-12)

        p = state.turn
        read = self._read(state, p)
        actions = abstract_actions(state, p, self.cfg)
        if not actions:
            return self._walk(state.apply(None), traverser, depth + 1,
                              reach_tr, reach_others, sample_reach)

        labels = [lab for lab, _ in actions]
        key = infoset_key(state, p, read, self.cfg)
        node = self._node(key, labels)
        strat = node.strategy()
        n = len(actions)

        # ε-探索付きサンプリング分布
        eps = 0.6 if p == traverser else 0.0
        sample_probs = eps / n + (1 - eps) * strat
        sample_probs = sample_probs / sample_probs.sum()
        a = int(self.nprng.choice(n, p=sample_probs))

        child = state.apply(actions[a][1])
        if p == traverser:
            util = self._walk(child, traverser, depth + 1,
                              reach_tr * strat[a], reach_others,
                              sample_reach * sample_probs[a])
            # 反実仮想値: サンプルした行動 a のみ実値, 他は 0(不偏推定)
            W = util * reach_others
            regrets = np.empty(n)
            for i in range(n):
                if i == a:
                    regrets[i] = W * (1.0 - strat[a])
                else:
                    regrets[i] = -W * strat[a]
            node.regret += regrets
            node.strategy_sum += (reach_tr / max(sample_reach, 1e-12)) * strat
            return util
        else:
            node.strategy_sum += strat  # 平均戦略の材料
            return self._walk(child, traverser, depth + 1,
                              reach_tr, reach_others * strat[a],
                              sample_reach * sample_probs[a])

    def train(self, iterations: int, deal_seed_base: int = 1000,
              log_every: int = 0) -> None:
        for it in range(iterations):
            rng = random.Random(deal_seed_base + it)
            state = GameState.deal(self.cfg, rng)
            self._read_cache.clear()
            for tr in range(self.cfg.num_players):
                self._walk(state.clone(), tr, 0, 1.0, 1.0, 1.0)
            if log_every and (it + 1) % log_every == 0:
                print(f"  [train] iter {it + 1}/{iterations}  "
                      f"infosets={len(self.nodes)}", flush=True)

    # --- 方策の保存/読込 (Webアプリ用) --------------------------------
    def save_policy(self, path: str) -> None:
        """学習済み情報集合(平均戦略の材料)を pickle 保存。"""
        import pickle
        data = {
            "num_players": self.cfg.num_players,
            "max_rank": self.cfg.max_rank,
            "hand_size": self.cfg.hand_size,
            "max_meld_size": self.cfg.max_meld_size,
            "coalition_mode": self.coalition_mode,
            "coalition_weight": self.coalition_weight,
            "nodes": {k: {"labels": nd.labels,
                          "regret": nd.regret,
                          "strategy_sum": nd.strategy_sum}
                      for k, nd in self.nodes.items()},
        }
        with open(path, "wb") as f:
            pickle.dump(data, f)

    @staticmethod
    def load_policy(path: str, bayes_samples: int = 20) -> "MCCFRTrainer":
        """save_policy で保存した方策を読み込んで trainer を復元。"""
        import pickle
        with open(path, "rb") as f:
            data = pickle.load(f)
        cfg = LexioConfig(data["num_players"], data["max_rank"],
                          data["hand_size"], data["max_meld_size"])
        tr = MCCFRTrainer(cfg, seed=0,
                          coalition_mode=data["coalition_mode"],
                          coalition_weight=data["coalition_weight"],
                          bayes_samples=bayes_samples)
        for k, nd in data["nodes"].items():
            node = Node(nd["labels"])
            node.regret = nd["regret"]
            node.strategy_sum = nd["strategy_sum"]
            tr.nodes[k] = node
        return tr

    # --- 学習後の方策で 1 手選ぶ ---------------------------------------
    def act(self, state: GameState, me: int, greedy: bool = True
            ) -> Tuple[str, Optional[Meld], BayesRead]:
        read = self.bayes.infer(state, me, n_samples=self.bayes_samples)
        actions = abstract_actions(state, me, self.cfg)
        if not actions:
            return ("PASS", None, read)
        labels = [lab for lab, _ in actions]
        key = infoset_key(state, me, read, self.cfg)
        node = self.nodes.get(key)
        if node is None or node.labels != labels:
            probs = self._heuristic_probs(labels, read, state, me)
        else:
            probs = node.average_strategy()
        idx = int(np.argmax(probs)) if greedy else int(self.nprng.choice(len(actions), p=probs))
        lab, m = actions[idx]
        return (lab, m, read)

    def _heuristic_probs(self, labels: List[str], read: BayesRead,
                         state: GameState, me: int) -> np.ndarray:
        """学習外の情報集合に対する簡易ヒューリスティック分布。
        連携対象なら早く手数を減らし, 連携側なら状況に応じて被せ/温存する。"""
        w = np.ones(len(labels))
        am_target = (state.target_player == me)
        for i, lab in enumerate(labels):
            if lab == "PASS":
                # 自分が最強を持つ確率が高い(=相手が勝てない)なら温存してパス
                w[i] = 0.8 + 1.5 * read.p_i_strongest
            elif lab == "PLAY_MIN":
                w[i] = 1.6                      # 最小限で勝つのが基本
            elif lab == "PLAY_STRONG":
                # 連携側で相手が勝ちやすいなら強く被せて止める
                w[i] = 1.0 + (1.2 if (self.coalition_mode and not am_target
                                      and read.p_any_opp_beats > 0.5) else 0.0)
            elif lab == "PLAY_SAVE2":
                w[i] = 1.3
            elif lab == "LEAD_SINGLE_LOW":
                w[i] = 1.5                      # リードは弱い単牌で様子見
            elif lab == "LEAD_SINGLE_HIGH":
                w[i] = 0.7
            elif lab == "LEAD_COMBO":
                w[i] = 1.2                      # 手数を減らす複数枚役
        return w / w.sum()


# =============================================================================
# セクション 8: 学習済み方策同士の対戦シミュレーション
# =============================================================================
def play_one_game(trainers: List[MCCFRTrainer], cfg: LexioConfig,
                  rng: random.Random, verbose: bool = False
                  ) -> Tuple[np.ndarray, int]:
    """各プレイヤーに割り当てた trainer で 1 ラウンドを完走。得点と勝者を返す。"""
    state = GameState.deal(cfg, rng)
    winner = -1
    step = 0
    while not state.is_terminal() and step < 400:
        p = state.turn
        lab, m, read = trainers[p].act(state, p, greedy=True)
        if verbose:
            cur = "-" if state.current is None else str(state.current)
            act = "PASS" if m is None else str(m)
            print(f"    P{p} 場[{cur}] -> {lab}:{act} "
                  f"(残{len(state.hands[p])} p_beat={read.p_any_opp_beats:.2f})")
        state = state.apply(m)
        if m is not None and not state.hands[p] and winner == -1:
            winner = p
        step += 1
    if winner == -1 and state.finished:
        winner = state.finished[0]
    return round_scores(state), winner


def play_one_game_t(trainers, cfg, rng, verbose=False):
    """play_one_game に加え, その配牌の対象(最強手)プレイヤーも返す。"""
    state = GameState.deal(cfg, rng)
    tgt = state.target_player
    winner, step = -1, 0
    while not state.is_terminal() and step < 400:
        p = state.turn
        lab, m, read = trainers[p].act(state, p, greedy=True)
        state = state.apply(m)
        if m is not None and not state.hands[p] and winner == -1:
            winner = p
        step += 1
    if winner == -1 and state.finished:
        winner = state.finished[0]
    return round_scores(state), winner, tgt


def evaluate(trainers: List[MCCFRTrainer], cfg: LexioConfig,
             games: int, seed: int = 5000) -> Dict:
    n = cfg.num_players
    wins = np.zeros(n)
    score = np.zeros(n)
    target_wins = 0           # 対象(最強手)が実際に勝った回数
    target_score = 0.0        # 対象の平均得点
    for g in range(games):
        rng = random.Random(seed + g)
        s, w, tgt = play_one_game_t(trainers, cfg, rng)
        score += s
        if w >= 0:
            wins[w] += 1
        if tgt >= 0:
            target_score += s[tgt]
            if w == tgt:
                target_wins += 1
    return {"win_rate": wins / games, "avg_score": score / games,
            "target_win_rate": target_wins / games,
            "target_avg_score": target_score / games}


# =============================================================================
# セクション 9: メイン (要件4: 盤面ごとの最適行動確率を出力)
# =============================================================================
def evaluate_coalition(selfish: "MCCFRTrainer", coop: "MCCFRTrainer",
                       cfg: LexioConfig, games: int, seed: int = 5000) -> Dict:
    """各配牌で最強手プレイヤーには利己的方策, 他家には連携方策を割り当てて対戦。
    連携が最強手プレイヤーを抑制できているかを測る。"""
    n = cfg.num_players
    wins = np.zeros(n)
    target_wins = 0
    target_score = 0.0
    for g in range(games):
        rng = random.Random(seed + g)
        state = GameState.deal(cfg, rng)
        tgt = state.target_player
        trainers = [selfish if i == tgt else coop for i in range(n)]
        winner, step = -1, 0
        while not state.is_terminal() and step < 400:
            p = state.turn
            _, m, _ = trainers[p].act(state, p, greedy=True)
            state = state.apply(m)
            if m is not None and not state.hands[p] and winner == -1:
                winner = p
            step += 1
        if winner == -1 and state.finished:
            winner = state.finished[0]
        s = round_scores(state)
        if winner >= 0:
            wins[winner] += 1
        target_score += s[tgt]
        if winner == tgt:
            target_wins += 1
    return {"win_rate": wins / games,
            "target_win_rate": target_wins / games,
            "target_avg_score": target_score / games}


def measure_target_advantage(cfg: LexioConfig, games: int = 300,
                             seed: int = 20) -> Dict:
    """ランダム方策下で「最強手(=一番手が良い)プレイヤー」が実際どれだけ
    勝ちやすいかを測定。連携なしのベースライン。"""
    rng_trainers = [MCCFRTrainer(cfg, seed=99) for _ in range(cfg.num_players)]
    return evaluate(rng_trainers, cfg, games=games, seed=seed)


def print_policy_table(trainer: MCCFRTrainer, top: int = 18):
    """学習した情報集合ごとの最適行動確率パスを見やすく出力。"""
    print("\n" + "=" * 74)
    print(" 学習された方策 (情報集合キー -> 行動確率)")
    print(" キー凡例: L=リード cs=場の枚数 nr=残牌 h2=2所持 na=生存数\n"
          "          ba=誰か勝てる確率bkt bs=自分最強確率bkt t=自分が抑制対象か")
    print("=" * 74)
    items = sorted(trainer.nodes.items(),
                   key=lambda kv: kv[1].strategy_sum.sum(), reverse=True)
    shown = 0
    for key, node in items:
        if node.strategy_sum.sum() < 1e-6:
            continue
        avg = node.average_strategy()
        parts = [f"{lab}:{p:.2f}" for lab, p in zip(node.labels, avg)]
        best = node.labels[int(np.argmax(avg))]
        print(f"  {key}")
        print(f"      {'  '.join(parts)}   => 最適: {best}")
        shown += 1
        if shown >= top:
            break
    print(f"  ... (総情報集合数 = {len(trainer.nodes)})")


def main():
    print("#" * 74)
    print("# レキシオ CFR + ベイズ推定 エージェント")
    print("#" * 74)

    NUM_PLAYERS = 3
    cfg = LexioConfig.standard(NUM_PLAYERS, max_meld_size=5)
    print(f"\n[設定] {NUM_PLAYERS}人戦 / 数字 1〜{cfg.max_rank} / "
          f"配牌 {cfg.hand_size}枚 / 役最大 {cfg.max_meld_size}枚")
    print("  研究テーマ: 各配牌で『最強手(=一番手が良い)』を持つプレイヤーを"
          "特定し,\n             残りのAIが連携してそのプレイヤーの勝利を"
          "抑制できるかを検証する。")

    ITER = 1800
    EVAL = 400

    # (A) ベースライン: ランダム方策で「最強手プレイヤー」の勝ちやすさを測定
    print("\n[段階A] ベースライン測定(ランダム方策)...")
    base = measure_target_advantage(cfg, games=EVAL, seed=20)
    print(f"  最強手プレイヤーの勝率 = {base['target_win_rate']:.3f} "
          f"(公平なら {1/NUM_PLAYERS:.3f})  平均得点 = {base['target_avg_score']:+.2f}")

    # (B) 利己的 CFR (各自が自分の得点最大化 / 連携なし)
    print(f"\n[段階B] 利己的CFRを学習 ({ITER}反復)...")
    selfish = MCCFRTrainer(cfg, seed=1, coalition_mode=False, bayes_samples=25)
    selfish.train(ITER, log_every=ITER // 3)
    res_self = evaluate([selfish] * cfg.num_players, cfg, games=EVAL, seed=7000)
    print(f"  最強手プレイヤーの勝率 = {res_self['target_win_rate']:.3f}  "
          f"平均得点 = {res_self['target_avg_score']:+.2f}")

    # (C) 連携CFR (各配牌の最強手プレイヤーを, 他家が連携して抑制)
    print(f"\n[段階C] 連携CFRを学習: 非対象AIが最強手プレイヤーを"
          f"勝たせないよう協調 ({ITER}反復)...")
    coop = MCCFRTrainer(cfg, seed=2, coalition_mode=True,
                        coalition_weight=0.75, bayes_samples=25)
    coop.train(ITER, log_every=ITER // 3)
    # 評価: 各配牌の最強手プレイヤーには利己的方策, 他家は連携方策を割り当てる
    res_coop = evaluate_coalition(selfish, coop, cfg, games=EVAL, seed=7000)
    print(f"  最強手プレイヤーの勝率 = {res_coop['target_win_rate']:.3f}  "
          f"平均得点 = {res_coop['target_avg_score']:+.2f}")

    # --- 研究結論 ------------------------------------------------------
    print("\n" + "=" * 74)
    print(" 研究結果: 連携による『一番手が良い人』の抑制効果")
    print("=" * 74)
    print(f"  最強手プレイヤーの勝率")
    print(f"    ランダム     : {base['target_win_rate']:.3f}")
    print(f"    利己的CFR    : {res_self['target_win_rate']:.3f}")
    print(f"    連携CFR      : {res_coop['target_win_rate']:.3f}")
    d = res_self['target_win_rate'] - res_coop['target_win_rate']
    print(f"  抑制効果 (利己的 - 連携) = {d:+.3f}")
    print(f"  平均得点(最強手): 利己的={res_self['target_avg_score']:+.2f} "
          f"-> 連携={res_coop['target_avg_score']:+.2f}")
    verdict = ("連携が有効: 最強手プレイヤーの勝率/得点を抑制できた"
               if d > 0.02 or res_coop['target_avg_score'] < res_self['target_avg_score']
               else "抑制効果は限定的")
    print(f"  => 結論: {verdict}")

    # --- 学習された方策の出力(要件4) ----------------------------------
    print_policy_table(coop, top=18)

    # --- 具体盤面での意思決定デモ --------------------------------------
    print("\n" + "=" * 74)
    print(" デモ: サンプル盤面での意思決定(ベイズ読み付き)")
    print("=" * 74)
    rng = random.Random(4242)
    demo = GameState.deal(cfg, rng)
    print(f"  この配牌の最強手プレイヤー = P{demo.target_player}")
    for _ in range(4):
        if demo.is_terminal():
            break
        p = demo.turn
        agent = selfish if p == demo.target_player else coop
        lab, m, read = agent.act(demo, p, greedy=True)
        role = "対象(最強手)" if p == demo.target_player else "連携AI"
        cur = "-(リード)" if demo.current is None else str(demo.current)
        print(f"  手番P{p}[{role}] 手牌[{hand_str(demo.hands[p])}]")
        print(f"    場={cur}  ベイズ: 誰か勝てる={read.p_any_opp_beats:.2f} "
              f"自分最強={read.p_i_strongest:.2f}")
        print(f"    => 行動 {lab}: {'PASS' if m is None else str(m)}")
        demo = demo.apply(m)

    print("\n[完了] すべての段階が正常に実行されました。")


if __name__ == "__main__":
    main()
