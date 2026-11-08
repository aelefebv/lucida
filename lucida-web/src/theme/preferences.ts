import { useCallback, useSyncExternalStore } from "react";
import { isCaptureSurface } from "../captureSurface.ts";

/**
 * Per-browser UI preferences in one versioned localStorage entry:
 *
 *     localStorage["lucida.preferences"] = { "version": 1, "values": { "<key>": <value> } }
 *
 * A module that owns a preference defines it beside itself, with no edit here:
 *
 *     export const leftPanelOpen = booleanPreference("shell.leftPanelOpen", true);
 *     const [open, setOpen] = usePreference(leftPanelOpen);
 *
 * Name keys `<area>.<name>`. A stored value that fails its parser reads as the
 * default, so a corrupt or outdated value never reaches a component.
 */

export const PREFERENCES_STORAGE_KEY = "lucida.preferences";

/** Bump when a stored key or value changes shape, and add a migration. */
export const PREFERENCES_VERSION = 1;

type StoredValues = Readonly<Record<string, unknown>>;

/**
 * Each entry upgrades values written at version `n` (its key) to `n + 1`.
 * Only renames and reshapes need one; a value its parser rejects already
 * falls back to the default.
 */
const MIGRATIONS: Readonly<Record<number, (values: StoredValues) => StoredValues>> = {};

export interface Preference<T> {
  readonly key: string;
  readonly defaultValue: T;
  /** Returns the value, or undefined when `raw` is not a valid value. */
  readonly parse: (raw: unknown) => T | undefined;
}

/** Define a preference with a custom parser. Prefer the typed builders below. */
export function definePreference<T>(
  key: string,
  defaultValue: T,
  parse: (raw: unknown) => T | undefined,
): Preference<T> {
  return { key, defaultValue, parse };
}

export function booleanPreference(key: string, defaultValue: boolean): Preference<boolean> {
  return definePreference(key, defaultValue, (raw) => (typeof raw === "boolean" ? raw : undefined));
}

/** A finite number, clamped into `range` so a stored width survives a new limit. */
export function numberPreference(
  key: string,
  defaultValue: number,
  range: { min?: number; max?: number } = {},
): Preference<number> {
  const { min = -Infinity, max = Infinity } = range;
  return definePreference(key, defaultValue, (raw) =>
    typeof raw === "number" && Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : undefined,
  );
}

/** One of a fixed set of strings. */
export function oneOfPreference<const V extends string>(
  key: string,
  values: readonly V[],
  defaultValue: NoInfer<V>,
): Preference<V> {
  return definePreference(key, defaultValue, (raw) =>
    typeof raw === "string" && (values as readonly string[]).includes(raw) ? (raw as V) : undefined,
  );
}

export interface PreferenceStore {
  get<T>(pref: Preference<T>): T;
  set<T>(pref: Preference<T>, value: T): void;
  /** Forget the stored value, so the preference reads as its default. */
  reset(pref: Preference<unknown>): void;
  /**
   * Replace the defaults for some keys, e.g. from a deployment's settings.
   * A value its preference rejects is ignored. Stored values still win.
   */
  setDefaults(defaults: StoredValues): void;
  /** Fires after any value or default changes, here or in another tab. */
  subscribe(listener: () => void): () => void;
}

interface Envelope {
  version: number;
  values: StoredValues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnvelope(storage: Storage | null): Envelope {
  const empty = { version: PREFERENCES_VERSION, values: {} };
  if (!storage) return empty;
  let parsed: unknown;
  try {
    const raw = storage.getItem(PREFERENCES_STORAGE_KEY);
    if (raw === null) return empty;
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isRecord(parsed) || typeof parsed.version !== "number" || !isRecord(parsed.values)) {
    return empty;
  }
  let { version } = parsed;
  let values: StoredValues = parsed.values;
  while (version < PREFERENCES_VERSION) {
    values = MIGRATIONS[version]?.(values) ?? values;
    version += 1;
  }
  // A newer build's entry is read as-is and keeps its version, so the newer
  // build does not migrate it a second time.
  return { version, values };
}

/**
 * A store over `storage`. Pass null for a memory-only store that starts from
 * `seed`, and otherwise from the defaults.
 */
export function createPreferenceStore(storage: Storage | null, seed: StoredValues = {}): PreferenceStore {
  let envelope = storage ? readEnvelope(storage) : { version: PREFERENCES_VERSION, values: seed };
  let defaults: StoredValues = {};
  const listeners = new Set<() => void>();
  // get() must return the same value until something changes, or
  // useSyncExternalStore re-renders forever on object-valued preferences.
  const cache = new Map<string, { raw: unknown; fallback: unknown; value: unknown }>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const write = (values: StoredValues) => {
    envelope = { version: envelope.version, values };
    if (!storage) return;
    try {
      storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // Quota or privacy mode: the value holds for this page and is lost on
      // reload, which beats throwing out of a settings click.
    }
  };

  const fallbackFor = <T>(pref: Preference<T>): T =>
    pref.key in defaults ? (pref.parse(defaults[pref.key]) ?? pref.defaultValue) : pref.defaultValue;

  if (storage && typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key !== null && event.key !== PREFERENCES_STORAGE_KEY) return;
      envelope = readEnvelope(storage);
      notify();
    });
  }

  return {
    get<T>(pref: Preference<T>): T {
      const raw = envelope.values[pref.key];
      const fallback = fallbackFor(pref);
      const hit = cache.get(pref.key);
      if (hit && hit.raw === raw && hit.fallback === fallback) return hit.value as T;
      const value = raw === undefined ? fallback : (pref.parse(raw) ?? fallback);
      cache.set(pref.key, { raw, fallback, value });
      return value;
    },
    set<T>(pref: Preference<T>, value: T) {
      if (Object.is(envelope.values[pref.key], value)) return;
      write({ ...envelope.values, [pref.key]: value });
      notify();
    },
    reset(pref) {
      if (!(pref.key in envelope.values)) return;
      const { [pref.key]: _removed, ...rest } = envelope.values;
      write(rest);
      notify();
    },
    setDefaults(next) {
      defaults = { ...defaults, ...next };
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The page global the trace driver sets before the page loads: preference
 * values by key, which the capture surface starts from. No other page reads
 * it, so a script can't reach a person's settings through it.
 */
export const PREFERENCE_SEED_GLOBAL = "lucidaPreferenceSeed";

function browserStorage(): Storage | null {
  // The capture surface renders the same pixels whoever's browser runs it,
  // so it reads no storage and persists nothing (see captureSurface.ts).
  if (isCaptureSurface()) return null;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function captureSeed(): StoredValues {
  if (!isCaptureSurface()) return {};
  const seed: unknown = (globalThis as Record<string, unknown>)[PREFERENCE_SEED_GLOBAL];
  return isRecord(seed) ? seed : {};
}

let storage = browserStorage();
let store = createPreferenceStore(storage, captureSeed());

// Subscribers attach here rather than to `store`, so they outlive a test's
// store reset.
const listeners = new Set<() => void>();
const notifyListeners = () => {
  for (const listener of [...listeners]) listener();
};
let detachStore = store.subscribe(notifyListeners);

interface LegacyMigration {
  isOld: (key: string) => boolean;
  migrate: (old: ReadonlyMap<string, string>) => void;
}

const legacyMigrations: LegacyMigration[] = [];

function runLegacyMigration({ isOld, migrate }: LegacyMigration): void {
  if (!storage) return;
  const old = new Map<string, string>();
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === null || key === PREFERENCES_STORAGE_KEY || !isOld(key)) continue;
      const raw = storage.getItem(key);
      if (raw !== null) old.set(key, raw);
    }
  } catch {
    return;
  }
  if (old.size === 0) return;
  migrate(old);
  for (const key of old.keys()) {
    try {
      storage.removeItem(key);
    } catch {
      // The key is read again next load and lands on the same values.
    }
  }
}

/**
 * Move values an older build kept under localStorage keys of its own into
 * preferences, once: `migrate` gets each key `isOld` accepts with its raw value
 * and sets the preferences they become, then those keys are removed. A key
 * that is still there was written after the last migration removed it, so its
 * value wins over the stored preference. Call it beside the preference's
 * definition, so it runs before anything reads the preference. The capture
 * surface has no storage, so there it reads and removes nothing.
 */
export function migrateLegacyKeys(
  isOld: (key: string) => boolean,
  migrate: (old: ReadonlyMap<string, string>) => void,
): void {
  const migration = { isOld, migrate };
  legacyMigrations.push(migration);
  runLegacyMigration(migration);
}

export function getPreference<T>(pref: Preference<T>): T {
  return store.get(pref);
}

export function setPreference<T>(pref: Preference<T>, value: T): void {
  store.set(pref, value);
}

export function resetPreference(pref: Preference<unknown>): void {
  store.reset(pref);
}

export function setPreferenceDefaults(defaults: StoredValues): void {
  store.setDefaults(defaults);
}

export function subscribePreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read and write one preference. Re-renders when it changes, in any tab. */
export function usePreference<T>(pref: Preference<T>): [T, (value: T) => void] {
  const value = useSyncExternalStore(
    subscribePreferences,
    () => store.get(pref),
    () => pref.defaultValue,
  );
  const setValue = useCallback((next: T) => store.set(pref, next), [pref]);
  return [value, setValue];
}

/**
 * Reopen the shared store as a fresh page would: from localStorage, or the
 * seed on the capture surface, then the legacy migrations. Tests only.
 */
export function __resetPreferencesForTesting(): void {
  detachStore();
  storage = browserStorage();
  store = createPreferenceStore(storage, captureSeed());
  detachStore = store.subscribe(notifyListeners);
  for (const migration of legacyMigrations) runLegacyMigration(migration);
  notifyListeners();
}

/**
 * Developer surfaces (monitor, HUD, dev controls, FPS) show only when on, and
 * the Dev controls knobs apply only when on.
 */
export const developerToolsPreference = booleanPreference("developer.tools", false);
