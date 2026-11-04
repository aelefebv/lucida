/**
 * One seam for scene mutation calls (`apply_command`, `load_document`,
 * `import_presence`, `import_dataset_presence`) from any origin. The session
 * controller owns the error surface but isn't in scope at most call sites, so
 * `guardedSceneCall` reports each outcome to observers and otherwise behaves
 * like the bare call.
 *
 * The registry is module-global, but each report carries the targeted scene as
 * `subject`. Sessions can coexist (workspace switch, StrictMode double mount),
 * and one session's success must not retire another's error banner.
 */

/**
 * Consequence classes for errors thrown by scene mutation calls:
 *
 * - `fatal`: the wasm instance can't recover this page load. A trap leaves it
 *   undefined, borrow poisoning ("recursive use of an object") persists once
 *   tripped, and "null pointer passed to rust" means the handle's object is
 *   gone. Later scene calls fail while the JS UI stays healthy.
 * - `incompatible`: refused at the deserialization boundary (e.g. a command
 *   shape from a newer peer). Scene state was never touched.
 * - `recoverable`: everything else, a state-dependent rejection that says
 *   nothing about later calls.
 */
export type SceneErrorClass = "fatal" | "incompatible" | "recoverable";

/** Signatures of wasm-bindgen failure modes that outlive the failing call
 *  (see the `fatal` class above). Message-substring matching is the only
 *  seam available: the bindings throw plain `Error`s. */
const FATAL_PATTERNS: readonly string[] = [
  "recursive use of an object",
  "null pointer passed to rust",
];

/** Deserialization-boundary signatures (serde / serde_json). The positional
 *  "at line N column M" suffix is appended by serde_json to every error it
 *  produces while parsing command JSON, so it identifies parse-boundary
 *  rejections that the named data-error patterns don't cover. */
const INCOMPATIBLE_PATTERNS: readonly (string | RegExp)[] = [
  "did not match any variant",
  "unknown variant",
  "unknown field",
  "missing field",
  "invalid type",
  "invalid value",
  / at line \d+ column \d+/,
];

export function classifySceneError(e: unknown): SceneErrorClass {
  if (typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError) {
    return "fatal";
  }
  const message = e instanceof Error ? e.message : String(e);
  for (const pattern of FATAL_PATTERNS) {
    if (message.includes(pattern)) {
      return "fatal";
    }
  }
  for (const pattern of INCOMPATIBLE_PATTERNS) {
    if (typeof pattern === "string" ? message.includes(pattern) : pattern.test(message)) {
      return "incompatible";
    }
  }
  return "recoverable";
}

export interface SceneCallObserver {
  /** A guarded scene mutation succeeded. `subject` is the scene it targeted;
   *  filter on it before reacting. */
  onSceneCallApplied(context: string, subject: unknown): void;
  /** A guarded scene mutation threw. The error is rethrown to the caller
   *  after observers return, so existing call-site handling still runs.
   *  `subject` is the scene the mutation targeted. */
  onSceneCallFailed(error: unknown, context: string, subject: unknown): void;
}

const observers = new Set<SceneCallObserver>();

/** Register an observer for every guarded scene call. Returns the
 *  unsubscribe function; the caller owns pairing it with its teardown. */
export function observeSceneCalls(observer: SceneCallObserver): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

/**
 * Run one scene mutation and report its outcome, tagged with the scene it
 * targeted (`subject`). Transparent to the caller: returns the call's value,
 * rethrows the call's error. Observer failures are contained (logged, never
 * propagated) so a misbehaving observer cannot corrupt an otherwise healthy
 * apply path.
 */
export function guardedSceneCall<T>(context: string, subject: unknown, call: () => T): T {
  let value: T;
  try {
    value = call();
  } catch (e) {
    for (const observer of [...observers]) {
      try {
        observer.onSceneCallFailed(e, context, subject);
      } catch (observerErr) {
        console.warn("[sceneGuard] observer failed while handling a scene error:", observerErr);
      }
    }
    throw e;
  }
  for (const observer of [...observers]) {
    try {
      observer.onSceneCallApplied(context, subject);
    } catch (observerErr) {
      console.warn("[sceneGuard] observer failed while handling a scene apply:", observerErr);
    }
  }
  return value;
}
