// Runs the AI search off the main thread so the board never freezes
// while the engine thinks.
import { aiMove } from './ai.js?v=157';

self.onmessage = (e) => {
  const { id, state, level, opts } = e.data;
  let move = null;
  try {
    move = aiMove(state, level, opts || {});
  } catch (err) {
    // report failure; the main thread falls back to computing synchronously
  }
  self.postMessage({ id, move });
};
