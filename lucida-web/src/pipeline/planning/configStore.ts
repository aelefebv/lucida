/**
 * Live planning-config store. Singleton holding the active
 * {@link PlanningConfig}, persisted to a single localStorage key with a
 * versioned envelope, with a subscribe API so the orchestrator can
 * invalidate its epoch cache when the user twists a knob.
 *
 * Slice 6 of the planning refactor (PRD #545). Honours principle §4 of
 * `wiki/principles/planning.md`: planning is pure and any state that
 * survives across ticks (or any policy knob the user might twist live)
 * is an explicit input. The configStore is the explicit-state container
 * for those knobs — `plan()` itself stays a function of
 * `(snapshot, config)`.
 *
 * Persistence schema (`localStorage["lucida.planning.config"]`):
 *
 *     { "schemaVersion": 1, "config": { ...PlanningConfig } }
 *
 * On load, a missing key, an unparseable value, or a `schemaVersion`
 * mismatch falls back to {@link DEFAULT_PLANNING_CONFIG} and logs one
 * line. The merge with defaults tolerates partial configs (older
 * persisted snapshots that pre-date a newly-added field).
 */

import {
  DEFAULT_PLANNING_CONFIG,
  mergeConfig,
  type PlanningConfig,
} from "./config.ts";

/** localStorage key for the persisted config envelope. */
const STORAGE_KEY = "lucida.planning.config";

/** Schema version for the persisted envelope. Bump on breaking changes. */
const SCHEMA_VERSION = 1;

type Listener = () => void;

export interface ConfigStore {
  /** Current snapshot. Returns the same reference until a `set`/`reset`. */
  get(): PlanningConfig;
  /** Update one field. Persists and notifies all subscribers. */
  set<K extends keyof PlanningConfig>(field: K, value: PlanningConfig[K]): void;
  /**
   * Reset a single field to its default, or (when `field` is omitted)
   * reset every field. Persists and notifies all subscribers.
   */
  reset(field?: keyof PlanningConfig): void;
  /**
   * Subscribe to config changes. The listener fires after the new config
   * is fully applied and persisted. Returns an unsubscribe function.
   */
  subscribe(listener: Listener): () => void;
  /**
   * Test-only escape hatch: rewind the singleton to defaults and clear
   * localStorage and listeners. Production code never calls this.
   */
  __resetForTesting(): void;
}

interface PersistedEnvelope {
  schemaVersion: number;
  config: Partial<PlanningConfig>;
}

/** Read the persisted envelope and merge with defaults. */
function hydrateFromStorage(): PlanningConfig {
  if (typeof localStorage === "undefined") {
    return { ...DEFAULT_PLANNING_CONFIG };
  }
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return { ...DEFAULT_PLANNING_CONFIG };
  }
  let parsed: PersistedEnvelope;
  try {
    parsed = JSON.parse(raw) as PersistedEnvelope;
  } catch {
    console.warn(
      `[planning.configStore] discarded unparseable ${STORAGE_KEY}; using defaults`,
    );
    return { ...DEFAULT_PLANNING_CONFIG };
  }
  if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) {
    console.warn(
      `[planning.configStore] schema mismatch (got ${parsed?.schemaVersion}, want ${SCHEMA_VERSION}); using defaults`,
    );
    return { ...DEFAULT_PLANNING_CONFIG };
  }
  // mergeConfig fills in any fields the persisted snapshot is missing
  // (e.g. a new lane offset added in a later release).
  return mergeConfig(parsed.config ?? {});
}

/** Persist the current config under the versioned envelope. */
function persistToStorage(config: PlanningConfig): void {
  if (typeof localStorage === "undefined") return;
  try {
    const envelope: PersistedEnvelope = {
      schemaVersion: SCHEMA_VERSION,
      config,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // localStorage can throw (quota exceeded, private browsing). Swallow:
    // an in-memory config that just doesn't persist is still better than
    // a thrown error in the UI.
  }
}

function clearStorage(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** True when every field of `cfg` matches `DEFAULT_PLANNING_CONFIG`. */
function isAllDefaults(cfg: PlanningConfig): boolean {
  for (const k of Object.keys(DEFAULT_PLANNING_CONFIG) as (keyof PlanningConfig)[]) {
    if (cfg[k] !== DEFAULT_PLANNING_CONFIG[k]) return false;
  }
  return true;
}

function createStore(): ConfigStore {
  let state: PlanningConfig = hydrateFromStorage();
  const listeners: Listener[] = [];

  const fire = () => {
    // Snapshot the listener list so a subscriber that unsubscribes (or
    // adds a new subscriber) inside its own handler doesn't mutate the
    // live array mid-iteration.
    for (const l of [...listeners]) {
      try {
        l();
      } catch (err) {
        console.error("[planning.configStore] listener threw", err);
      }
    }
  };

  return {
    get(): PlanningConfig {
      return state;
    },

    set<K extends keyof PlanningConfig>(field: K, value: PlanningConfig[K]): void {
      if (state[field] === value) return;
      state = { ...state, [field]: value };
      if (isAllDefaults(state)) {
        clearStorage();
      } else {
        persistToStorage(state);
      }
      fire();
    },

    reset(field?: keyof PlanningConfig): void {
      if (field === undefined) {
        if (isAllDefaults(state)) {
          // No-op: would not change observable state and would not need
          // to fire listeners. Keep the same reference so subscribers
          // that compare by identity aren't tricked.
          clearStorage();
          return;
        }
        state = { ...DEFAULT_PLANNING_CONFIG };
        clearStorage();
        fire();
        return;
      }
      const def = DEFAULT_PLANNING_CONFIG[field];
      if (state[field] === def) return;
      state = { ...state, [field]: def };
      if (isAllDefaults(state)) {
        clearStorage();
      } else {
        persistToStorage(state);
      }
      fire();
    },

    subscribe(listener: Listener): () => void {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    __resetForTesting(): void {
      state = { ...DEFAULT_PLANNING_CONFIG };
      listeners.length = 0;
      clearStorage();
    },
  };
}

/**
 * The application-wide planning config. Imported by the orchestrator
 * (read on every full plan tick + subscribed to so config tweaks
 * invalidate the epoch cache) and by the DebugPanel's Config tab
 * (read for rendering, written via `set`/`reset`).
 */
export const configStore: ConfigStore = createStore();
