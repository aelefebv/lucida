/**
 * Identity 4x4 column-major matrix. Each call returns a fresh
 * `Float32Array(16)` — callers retain exclusive ownership (the worker
 * boundary may transfer them).
 */
export function identityMatrix(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
