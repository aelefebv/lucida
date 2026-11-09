/**
 * Dev controls: the one mutation surface for the pipeline. Its planning knobs
 * ({@link configStore}) and four `CpuCache` knobs are preferences, persisted in
 * this browser and applied only while developer tools are on.
 *
 * Writes are dev-build only. "Reset all to defaults" works in every build:
 * with developer tools on, persisted knobs steer a production build too, and a
 * read-only panel has no other way back.
 */

import { ArrowCounterClockwiseIcon, CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { configStore, type PlanningKnob } from "../pipeline/planning/configStore.ts";
import {
  DEFAULT_PLANNING_CONFIG,
  type PlanningConfig,
} from "../pipeline/planning/config.ts";
import {
  CACHE_KNOB_FIELDS,
  CACHE_KNOB_PREFERENCES,
  type CacheKnobField,
} from "../pipeline/fetch/cacheKnobs.ts";
import type { CpuCacheConfig } from "../pipeline/fetch/index.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import {
  getPreference,
  resetPreference,
  subscribePreferences,
  usePreference,
} from "../theme/preferences.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { NumberField } from "../ui/NumberField.tsx";
import { Slider } from "../ui/Slider.tsx";
import { getRenderRadiusPreviewTier, setRenderRadiusPreviewTier } from "./logging.ts";
import "./DevControls.css";

// Per-field UI metadata. The panel renders from these arrays, so a new field
// needs only a row here, and a preference beside the others in configStore.ts
// whose range matches.

interface TunableSpec {
  field: PlanningKnob;
  label: string;
  min: number;
  max: number;
  step: number;
  previewRadiusTier?: ResidencyTier;
}

const PREFETCH: TunableSpec[] = [
  { field: "prefetchDepth", label: "Prefetch depth", min: 0, max: 5, step: 1 },
  { field: "sliceBandPlanes", label: "Slice band (planes)", min: 0, max: 32, step: 1 },
];

const PRIORITY_WEIGHTS: TunableSpec[] = [
  { field: "importanceWeight", label: "Importance weight", min: 10, max: 2000, step: 10 },
  { field: "distanceWeight", label: "Distance weight", min: 1, max: 100, step: 1 },
];

// `depthBiasView` is user-facing, so it lives in
// components/FocalDepthControl.tsx, writable in every build, not among these
// developer tunables.

const RESIDENCY_BUDGETS: TunableSpec[] = [
  {
    field: "detailRenderRadiusView",
    label: "Detail render radius (view)",
    min: 0,
    max: 2,
    step: 0.05,
    previewRadiusTier: "detail",
  },
  {
    field: "coarseRenderRadiusView",
    label: "Coarse render radius (view)",
    min: 0,
    max: 2,
    step: 0.05,
    previewRadiusTier: "coarse",
  },
];

const LANE_OFFSETS: TunableSpec[] = [
  { field: "minimapLaneOffset", label: "MINIMAP lane offset", min: 0, max: 5000, step: 50 },
  { field: "detailLaneOffset", label: "DETAIL lane offset", min: 0, max: 5000, step: 50 },
  { field: "prefetchLaneOffset", label: "PREFETCH lane offset", min: 0, max: 5000, step: 50 },
  { field: "coarseLaneOffset", label: "COARSE lane offset", min: 0, max: 5000, step: 50 },
];

// Canonical lane priority order, lowest offset (most urgent) first. Used
// to detect inversions in the lane-offsets section.
const LANE_ORDER: PlanningKnob[] = [
  "minimapLaneOffset",
  "detailLaneOffset",
  "prefetchLaneOffset",
  "coarseLaneOffset",
];

/**
 * The slice of the live `CpuCache` this surface reads: the values the cache
 * runs under, knob or not. Edits go to the knob preferences, which the
 * session applies to its cache.
 */
export interface LiveCacheKnobs {
  getConfig(): Readonly<Pick<CpuCacheConfig, CacheKnobField>>;
}

interface CacheKnobSpec {
  field: CacheKnobField;
  label: string;
  /** Megabytes on screen, bytes in the config. */
  megabytes: boolean;
}

const CACHE_KNOBS: CacheKnobSpec[] = [
  { field: "mainBudgetBytes", label: "Main budget (MB)", megabytes: true },
  { field: "overviewBudgetBytes", label: "Overview budget (MB)", megabytes: true },
  { field: "maxConcurrentFetches", label: "Max fetches", megabytes: false },
  { field: "maxBytesInFlight", label: "Max in-flight (MB)", megabytes: true },
];

/**
 * Returns a warning when a given lane offset breaks the canonical order
 * MINIMAP < DETAIL < PREFETCH < COARSE. The warning attaches
 * to the field whose value disagrees with its neighbour.
 */
function laneOrderWarning(
  cfg: PlanningConfig,
  field: PlanningKnob,
): string | null {
  const idx = LANE_ORDER.indexOf(field);
  if (idx < 0) return null;
  const value = cfg[field];
  if (idx > 0) {
    const prev = LANE_ORDER[idx - 1];
    if (value < cfg[prev]) {
      return `Below ${labelForField(prev)} — inverts canonical lane order.`;
    }
  }
  if (idx < LANE_ORDER.length - 1) {
    const next = LANE_ORDER[idx + 1];
    if (value > cfg[next]) {
      return `Above ${labelForField(next)} — inverts canonical lane order.`;
    }
  }
  return null;
}

function labelForField(field: PlanningKnob): string {
  for (const spec of [
    ...PREFETCH,
    ...PRIORITY_WEIGHTS,
    ...RESIDENCY_BUDGETS,
    ...LANE_OFFSETS,
  ]) {
    if (spec.field === field) return spec.label;
  }
  return String(field);
}

function usePlanningConfig(): PlanningConfig {
  return useSyncExternalStore(
    (cb) => configStore.subscribe(cb),
    () => configStore.get(),
    () => configStore.get(),
  );
}

/**
 * One tunable row: a slider with its label and editable value, a reset arrow
 * (visible only when the value differs from the default), and an optional
 * warning line.
 *
 * The row is the same shape for all sections; per-section variation
 * lives entirely in the `TunableSpec` table above.
 */
function TunableRow({
  spec,
  cfg,
  warning,
  editable,
}: {
  spec: TunableSpec;
  cfg: PlanningConfig;
  warning: string | null;
  editable: boolean;
}) {
  const value = cfg[spec.field];
  const def = DEFAULT_PLANNING_CONFIG[spec.field];
  const dirty = value !== def;

  const onChange = (next: number) => {
    if (!editable) return;
    if (Number.isNaN(next)) return;
    const clamped = Math.min(spec.max, Math.max(spec.min, next));
    configStore.set(spec.field, clamped);
  };

  // A radius previews while its value is being adjusted, until the press or
  // key adjusting it lifts. The slider's own change end misses an edit that
  // reaches its input directly.
  const preview = () => {
    const tier = spec.previewRadiusTier;
    if (!tier || !editable || getRenderRadiusPreviewTier() === tier) return;
    setRenderRadiusPreviewTier(tier);
    const lifted = new AbortController();
    const clear = () => {
      setRenderRadiusPreviewTier(null);
      lifted.abort();
    };
    for (const type of ["pointerup", "pointercancel", "keyup"]) {
      window.addEventListener(type, clear, { signal: lifted.signal });
    }
  };

  return (
    <div className="dev-controls-tunable-row">
      <div className="dev-controls-tunable-controls">
        <Slider
          className="dev-controls-tunable-slider"
          data-testid={`cfg-${spec.field}`}
          label={spec.label}
          value={value}
          minValue={spec.min}
          maxValue={spec.max}
          step={spec.step}
          valueDisplay="field"
          isDisabled={!editable}
          onChange={(next) => {
            preview();
            onChange(next);
          }}
        />
        {editable && dirty ? (
          <IconButton
            icon={ArrowCounterClockwiseIcon}
            label={`Reset ${spec.label} to ${def}`}
            size="sm"
            tooltipPlacement="left"
            onPress={() => configStore.reset(spec.field)}
          />
        ) : (
          // Reserved-width spacer so rows don't reflow on the appear/disappear
          // boundary — the arrow flickering shifting other controls is more
          // annoying than the empty space.
          <span className="dev-controls-reset-placeholder" aria-hidden="true" />
        )}
      </div>
      {warning && (
        <div className="dev-controls-warn" role="alert">
          {warning}
        </div>
      )}
    </div>
  );
}

/** Whether any cache knob holds a value of its own. */
function useAnyCacheKnobSet(): boolean {
  return useSyncExternalStore(
    subscribePreferences,
    () => CACHE_KNOB_FIELDS.some((field) => getPreference(CACHE_KNOB_PREFERENCES[field]) !== null),
    () => false,
  );
}

/**
 * One cache knob. It shows the value the live cache runs under, which is the
 * cache's own until the knob is set, and writes the knob's preference.
 */
function CacheKnobRow({
  knob,
  values,
  editable,
}: {
  knob: CacheKnobSpec;
  values: Readonly<Pick<CpuCacheConfig, CacheKnobField>>;
  editable: boolean;
}) {
  const pref = CACHE_KNOB_PREFERENCES[knob.field];
  const [stored, setStored] = usePreference(pref);
  const divisor = knob.megabytes ? 1024 * 1024 : 1;
  return (
    <div className="dev-controls-row">
      <span>{knob.label}</span>
      <div className="dev-controls-tunable-controls">
        <NumberField
          className="dev-controls-input"
          label={knob.label}
          labelPosition="hidden"
          hideSteppers
          value={Math.round(values[knob.field] / divisor)}
          isDisabled={!editable}
          onChange={(shown) => {
            if (!editable || !(shown > 0)) return;
            setStored(shown * divisor);
          }}
        />
        {editable && stored !== null ? (
          <IconButton
            icon={ArrowCounterClockwiseIcon}
            label={`Reset ${knob.label} to the cache's own value`}
            size="sm"
            tooltipPlacement="left"
            onPress={() => resetPreference(pref)}
          />
        ) : (
          <span className="dev-controls-reset-placeholder" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

/**
 * The four `CpuCache` knobs. Values are read off the live config rather than
 * copied into React state, which could go stale. The session can be replaced
 * independently of this surface, so the cache comes in as a getter re-read on
 * a slow tick.
 */
const CACHE_POLL_INTERVAL_MS = 1000;

function CacheSection({
  getCpuCache,
  editable,
}: {
  getCpuCache: () => LiveCacheKnobs | null;
  editable: boolean;
}) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(refresh, CACHE_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
  const values = getCpuCache()?.getConfig() ?? null;

  return (
    <div className="dev-controls-section">
      <div className="dev-controls-title">Cache</div>
      {!values ? (
        <div className="dev-controls-note">No session connected.</div>
      ) : (
        CACHE_KNOBS.map((knob) => (
          <CacheKnobRow key={knob.field} knob={knob} values={values} editable={editable} />
        ))
      )}
    </div>
  );
}

function resetAllKnobs(): void {
  configStore.reset();
  for (const field of CACHE_KNOB_FIELDS) resetPreference(CACHE_KNOB_PREFERENCES[field]);
}

export function DevControls({
  getCpuCache = () => null,
  editable = import.meta.env.DEV,
}: {
  /** Live cache the cache knobs show; null when no session is up. */
  getCpuCache?: () => LiveCacheKnobs | null;
  /** Whether the knobs accept edits. Defaults to dev-build-only. */
  editable?: boolean;
} = {}) {
  const cfg = usePlanningConfig();
  const anyCacheKnobSet = useAnyCacheKnobSet();
  // Lane offsets default to collapsed — they're a structural knob most
  // users should not be tweaking; surface a warning above them when
  // expanded so the consequences are explicit.
  const [laneOffsetsExpanded, setLaneOffsetsExpanded] = useState(false);

  const warningFor = (field: PlanningKnob): string | null =>
    LANE_ORDER.includes(field) ? laneOrderWarning(cfg, field) : null;

  const allDefaults =
    !anyCacheKnobSet &&
    (Object.keys(DEFAULT_PLANNING_CONFIG) as (keyof PlanningConfig)[]).every(
      (k) => cfg[k] === DEFAULT_PLANNING_CONFIG[k],
    );

  return (
    <div className="dev-controls">
      <div className="dev-controls-content">
        <div className="dev-controls-section">
          <div className="dev-controls-title">Dev controls</div>
          {editable ? (
            <div className="dev-controls-note">
              Live tunables. Each change applies at once and persists in this
              browser, while developer tools are on.
            </div>
          ) : (
            <div className="dev-controls-note" role="note">
              Read-only in this build: live values shown for inspection;
              editing is a dev-build capability. Reset all still works,
              clearing any persisted knobs.
            </div>
          )}
          {/* Reset-all stays enabled in every build, where only single-knob
              edits are dev-gated: with developer tools on, persisted knobs
              steer a production build's planner too. */}
          <Button size="sm" onPress={resetAllKnobs} isDisabled={allDefaults}>
            Reset all to defaults
          </Button>
        </div>

        <div className="dev-controls-section">
          <div className="dev-controls-title">Prefetch</div>
          {PREFETCH.map((spec) => (
            <TunableRow
              key={spec.field}
              spec={spec}
              cfg={cfg}
              warning={warningFor(spec.field)}
              editable={editable}
            />
          ))}
        </div>

        <div className="dev-controls-section">
          <div className="dev-controls-title">Priority weights</div>
          {PRIORITY_WEIGHTS.map((spec) => (
            <TunableRow
              key={spec.field}
              spec={spec}
              cfg={cfg}
              warning={warningFor(spec.field)}
              editable={editable}
            />
          ))}
        </div>

        <div className="dev-controls-section">
          <div className="dev-controls-title">Residency budgets</div>
          <div className="dev-controls-note">
            Render radius is a visible-view multiplier; max disables radius filtering.
          </div>
          {RESIDENCY_BUDGETS.map((spec) => (
            <TunableRow
              key={spec.field}
              spec={spec}
              cfg={cfg}
              warning={warningFor(spec.field)}
              editable={editable}
            />
          ))}
        </div>

        <div className="dev-controls-section">
          <div className="dev-controls-title dev-controls-title-split">
            <span>Lane offsets</span>
            <Button
              size="sm"
              variant="ghost"
              trailingIcon={laneOffsetsExpanded ? CaretDownIcon : CaretRightIcon}
              onPress={() => setLaneOffsetsExpanded((v) => !v)}
              aria-expanded={laneOffsetsExpanded}
              aria-controls="cfg-lane-offsets"
            >
              {laneOffsetsExpanded ? "Hide" : "Show"}
            </Button>
          </div>
          {laneOffsetsExpanded && (
            <div id="cfg-lane-offsets">
              <div className="dev-controls-warn" role="note">
                Structural knobs: changing lane offsets reorders the queue
                priorities across the system. The canonical order is
                MINIMAP &lt; DETAIL &lt; PREFETCH &lt; COARSE.
              </div>
              {LANE_OFFSETS.map((spec) => (
                <TunableRow
                  key={spec.field}
                  spec={spec}
                  cfg={cfg}
                  warning={warningFor(spec.field)}
                  editable={editable}
                />
              ))}
            </div>
          )}
        </div>

        <CacheSection getCpuCache={getCpuCache} editable={editable} />
      </div>
    </div>
  );
}
