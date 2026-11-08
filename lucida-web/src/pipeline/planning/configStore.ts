/**
 * The {@link PlanningConfig} the planner runs under, read from preferences.
 *
 * Each Dev controls knob is a preference clamped to the range the panel
 * offers, and applies only while developer tools are on, so a knob left over
 * from an experiment never steers a person's planner or a capture. Focal depth
 * is a person's own setting and always applies.
 */

import {
  developerToolsPreference,
  getPreference,
  migrateLegacyKeys,
  numberPreference,
  resetPreference,
  setPreference,
  subscribePreferences,
  type Preference,
} from "../../theme/preferences.ts";
import { DEFAULT_PLANNING_CONFIG, type PlanningConfig } from "./config.ts";

const D = DEFAULT_PLANNING_CONFIG;

/** The Dev controls planning knobs. */
export const PLANNING_KNOB_PREFERENCES = {
  prefetchDepth: numberPreference("planning.prefetchDepth", D.prefetchDepth, { min: 0, max: 5 }),
  importanceWeight: numberPreference("planning.importanceWeight", D.importanceWeight, { min: 10, max: 2000 }),
  distanceWeight: numberPreference("planning.distanceWeight", D.distanceWeight, { min: 1, max: 100 }),
  detailRenderRadiusView: numberPreference("planning.detailRenderRadiusView", D.detailRenderRadiusView, {
    min: 0,
    max: 2,
  }),
  coarseRenderRadiusView: numberPreference("planning.coarseRenderRadiusView", D.coarseRenderRadiusView, {
    min: 0,
    max: 2,
  }),
  minimapLaneOffset: numberPreference("planning.minimapLaneOffset", D.minimapLaneOffset, { min: 0, max: 5000 }),
  detailLaneOffset: numberPreference("planning.detailLaneOffset", D.detailLaneOffset, { min: 0, max: 5000 }),
  prefetchLaneOffset: numberPreference("planning.prefetchLaneOffset", D.prefetchLaneOffset, { min: 0, max: 5000 }),
  coarseLaneOffset: numberPreference("planning.coarseLaneOffset", D.coarseLaneOffset, { min: 0, max: 5000 }),
} as const satisfies Partial<Record<keyof PlanningConfig, Preference<number>>>;

export type PlanningKnob = keyof typeof PLANNING_KNOB_PREFERENCES;

/** The focal-depth slider: the near↔far bias of the 3D spawn origin. */
export const depthBiasPreference = numberPreference("planning.depthBiasView", D.depthBiasView, { min: -1, max: 1 });

/** Every planning field a preference holds. The rest stay at their defaults. */
export type PlanningPreferenceField = PlanningKnob | "depthBiasView";

const PREFERENCES: Readonly<Record<PlanningPreferenceField, Preference<number>>> = {
  ...PLANNING_KNOB_PREFERENCES,
  depthBiasView: depthBiasPreference,
};

const FIELDS = Object.keys(PREFERENCES) as PlanningPreferenceField[];

/** Store `value`, or forget the field at its default so a later default still reaches it. */
function store(field: PlanningPreferenceField, value: number): void {
  const pref = PREFERENCES[field];
  if (value === pref.defaultValue) resetPreference(pref);
  else setPreference(pref, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

migrateLegacyKeys(
  (key) => key === "lucida.planning.config",
  (old) => {
    for (const raw of old.values()) {
      let envelope: unknown;
      try {
        envelope = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isRecord(envelope) || envelope.schemaVersion !== 3 || !isRecord(envelope.config)) continue;
      for (const field of FIELDS) {
        const value = PREFERENCES[field].parse(envelope.config[field]);
        if (value !== undefined) store(field, value);
      }
    }
  },
);

type Listener = () => void;

export interface ConfigStore {
  /** The config the planner runs under. The same reference until it changes. */
  get(): PlanningConfig;
  /** Store one field's preference. Notifies subscribers if the config changed. */
  set(field: PlanningPreferenceField, value: number): void;
  /** Forget one field's preference, or every field's when `field` is omitted. */
  reset(field?: PlanningPreferenceField): void;
  /**
   * Subscribe to changes of {@link get}, including those from turning
   * developer tools on or off. Returns an unsubscribe function.
   */
  subscribe(listener: Listener): () => void;
  /** Forget every field's preference. Tests only. */
  __resetForTesting(): void;
}

let current: PlanningConfig = { ...DEFAULT_PLANNING_CONFIG };

function read(): PlanningConfig {
  const knobsApply = getPreference(developerToolsPreference);
  let next: PlanningConfig | null = null;
  for (const field of FIELDS) {
    const value =
      knobsApply || field === "depthBiasView" ? getPreference(PREFERENCES[field]) : DEFAULT_PLANNING_CONFIG[field];
    if (value !== current[field]) (next ??= { ...current })[field] = value;
  }
  if (next) current = next;
  return current;
}

function resetAll(): void {
  for (const field of FIELDS) resetPreference(PREFERENCES[field]);
}

/** Application-wide planning config. */
export const configStore: ConfigStore = {
  get: read,
  set: store,
  reset(field) {
    if (field === undefined) resetAll();
    else resetPreference(PREFERENCES[field]);
  },
  subscribe(listener) {
    let seen = read();
    return subscribePreferences(() => {
      const next = read();
      if (next === seen) return;
      seen = next;
      try {
        listener();
      } catch (err) {
        console.error("[planning.configStore] listener threw", err);
      }
    });
  },
  __resetForTesting: resetAll,
};
