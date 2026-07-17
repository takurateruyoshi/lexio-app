// ai.worker.js — AI思考を別スレッドで実行する module worker
"use strict";
import { GameState, standardConfig } from "./engine.js";
import { BeliefState, chooseMove } from "./ai.js";

self.onmessage = (ev) => {
  const { id, numPlayers, state, me, belief, opts } = ev.data;
  try {
    const cfg = standardConfig(numPlayers);
    const st = GameState.fromJSON(cfg, state);
    const b = BeliefState.fromJSON(cfg, belief);
    const { move, thought } = chooseMove(st, me, b, opts || {});
    self.postMessage({ id, moveTiles: move ? move.tiles : null, thought });
  } catch (e) {
    self.postMessage({ id, error: String(e && e.message || e) });
  }
};
