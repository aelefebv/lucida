/**
 * Identity 4x4 column-major matrix factory.
 *
 * Used as a defensive fallback inside `sendColdState` for active-set
 * entries that don't have a precomputed model matrix from the planning
 * roster (e.g. transient inconsistency between the roster pass and the
 * cold-state emit), and by `renderLoop` to draw an empty-canvas pass
 * when the dataset set becomes empty.
 *
 * Each call returns a fresh `Float32Array(16)` — callers retain
 * exclusive ownership and the worker boundary may transfer them.
 */
export function identityMatrix(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
