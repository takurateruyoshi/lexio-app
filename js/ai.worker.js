// ai.worker.js — AI思考を別スレッドで実行する module worker
"use strict";
import { GameState, classify, standardConfig } from "./engine.js";
import { BeliefState, chooseMove } from "./ai.js";

function restoreState(cfg, s) {
  const st = new GameState(cfg);
  st.hands = s.hands.map((h) => [...h]);
  st.hidden = [...s.hidden];
  st.current = s.currentTiles ? classify(s.currentTiles, cfg.maxRank) : null;
  st.leader = s.leader;
  st.turn = s.turn;
  st.passed = [...s.passed];
  st.lastPlayer = s.lastPlayer;
  st.played = Array.from({ length: cfg.numPlayers }, () => []);
  st.finished = [...s.finished];
  return st;
}

self.onmessage = (ev) => {
  const { id, numPlayers, state, me, belief, opts } = ev.data;
  try {
    const cfg = standardConfig(numPlayers);
    const st = restoreState(cfg, state);
    const b = BeliefState.fromJSON(cfg, belief);
    const { move, thought } = chooseMove(st, me, b, opts || {});
    self.postMessage({ id, moveTiles: move ? move.tiles : null, thought });
  } catch (e) {
    self.postMessage({ id, error: String(e && e.message || e) });
  }
};
