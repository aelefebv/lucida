/**
 * Dev controls — the one surviving *mutation* surface for the pipeline,
 * a standalone panel docked to the right of the canvas and opened from
 * the toolbar. See `wiki/decisions/0052-debug-surface-dispositions.md`.
 *
 * It is named for mutation rather than for configuration because
 * configuration is only one of its contents:
 *
 *   1. the planning knobs backed by {@link configStore} (persisted to
 *      localStorage; the planner reads them on every tick), and
 *   2. four `CpuCache` knobs that are **session-scoped**: they go
 *      through `updateConfig`, an `Object.assign` onto the live cache
 *      instance, and die on reload.
 *
 * The overlay toggles used to be a third content and now live in the HUD
 * legend (`hud/HudLegend.tsx`), since the overlays are product surfaces
 * togglable in every build. The render-radius drag preview on the sliders
 * still mounts the overlay layer for the length of the drag.
 *
 * Those two lifetimes sit side by side, so the session-scoped section
 * says so on screen: controls that silently reset next to controls that
 * do not is a trap. (Unifying them onto one store is deliberately out of
 * scope — see `wiki/decisions/deferred.md`.)
 *
 * Every knob here is a developer tunable, so writes are dev-build only
 * (`editable` defaults to `import.meta.env.DEV`); production builds
 * render live values read-only. One exception: "Reset all to defaults"
 * works in every build — planning knobs persisted by an earlier session
 * still steer the planner in production, and resetting *toward* defaults
 * is a safety valve, not a steering control; without it the only
 * recovery is a manual localStorage wipe. The one planning-config field
 * that IS product config, `depthBiasView`, is deliberately not rendered
 * here — it lives in the main 3-D view UI
 * (components/FocalDepthControl.tsx) and stays writable in every build.
 *
 * Cross-constraint warning (warn but allow): lane offsets that invert
 * the canonical priority order (MINIMAP < DETAIL < PROXY < PREFETCH <
 * COARSE), shown under the affected lane field.
 */

import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { configStore } from "../pipeline/planning/configStore.ts";
import {
  DEFAULT_PLANNING_CONFIG,
  type PlanningConfig,
} from "../pipeline/planning/config.ts";
import type { CpuCacheConfig } from "../pipeline/fetch/index.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import { setRenderRadiusPreviewTier } from "./logging.ts";
import "./DevControls.css";

// Single source of truth for the per-field UI metadata: label, slider
// bounds + step, and the section grouping. The render loop walks these
// arrays — new fields show up just by adding a row here.

interface TunableSpec {
  field: keyof PlanningConfig;
  label: string;
  min: number;
  max: number;
  step: number;
  previewRadiusTier?: ResidencyTier;
}

const PREFETCH: TunableSpec[] = [
  { field: "prefetchDepth", label: "Prefetch depth", min: 0, max: 5, step: 1 },
];

const PRIORITY_WEIGHTS: TunableSpec[] = [
  { field: "importanceWeight", label: "Importance weight", min: 10, max: 2000, step: 10 },
  { field: "distanceWeight", label: "Distance weight", min: 1, max: 100, step: 1 },
  {
    field: "groupProxyPriorityBump",
    label: "Group-proxy priority bump",
    min: 0,
    max: 500,
    step: 5,
  },
];

// Note: the 3-D chunk-spawn focal-depth control (issue #532,
// `depthBiasView`) is a USER-facing knob and lives in the main 3-D view
// UI (see components/FocalDepthControl.tsx), not here among the
// developer planning tunables. It binds to the same configStore field.

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
  {
    field: "proxyResidencyBudgetBytes",
    label: "Proxy GPU budget (bytes)",
    min: 16 * 1024 * 1024,
    max: 512 * 1024 * 1024,
    step: 16 * 1024 * 1024,
  },
];

const LANE_OFFSETS: TunableSpec[] = [
  { field: "minimapLaneOffset", label: "MINIMAP lane offset", min: 0, max: 5000, step: 50 },
  { field: "detailLaneOffset", label: "DETAIL lane offset", min: 0, max: 5000, step: 50 },
  { field: "proxyLaneOffset", label: "PROXY lane offset", min: 0, max: 5000, step: 50 },
  { field: "prefetchLaneOffset", label: "PREFETCH lane offset", min: 0, max: 5000, step: 50 },
  { field: "coarseLaneOffset", label: "COARSE lane offset", min: 0, max: 5000, step: 50 },
];

// Canonical lane priority order, lowest offset (most urgent) first. Used
// to detect inversions in the lane-offsets section.
const LANE_ORDER: (keyof PlanningConfig)[] = [
  "minimapLaneOffset",
  "detailLaneOffset",
  "proxyLaneOffset",
  "prefetchLaneOffset",
  "coarseLaneOffset",
];

/** The four session-scoped cache knobs, in display order. */
type CacheKnobField =
  | "mainBudgetBytes"
  | "overviewBudgetBytes"
  | "maxConcurrentFetches"
  | "maxBytesInFlight";

/**
 * The slice of the live `CpuCache` this surface touches: read the
 * current config, write a partial back. Narrow on purpose — Dev controls
 * has no business with the rest of the cache.
 */
export interface LiveCacheKnobs {
  getConfig(): Readonly<Pick<CpuCacheConfig, CacheKnobField>>;
  updateConfig(partial: Partial<CpuCacheConfig>): void;
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
 * MINIMAP < DETAIL < PROXY < PREFETCH < COARSE. The warning attaches
 * to the field whose value disagrees with its neighbour.
 */
function laneOrderWarning(
  cfg: PlanningConfig,
  field: keyof PlanningConfig,
): string | null {
  const idx = LANE_ORDER.indexOf(field);
  if (idx < 0) return null;
  const value = cfg[field] as number;
  if (idx > 0) {
    const prev = LANE_ORDER[idx - 1];
    if (value < (cfg[prev] as number)) {
      return `Below ${labelForField(prev)} — inverts canonical lane order.`;
    }
  }
  if (idx < LANE_ORDER.length - 1) {
    const next = LANE_ORDER[idx + 1];
    if (value > (cfg[next] as number)) {
      return `Above ${labelForField(next)} — inverts canonical lane order.`;
    }
  }
  return null;
}

function labelForField(field: keyof PlanningConfig): string {
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
 * One tunable row: label + slider + number input + reset arrow (visible
 * only when the value differs from the default) + optional warning line.
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
  const value = cfg[spec.field] as number;
  const def = DEFAULT_PLANNING_CONFIG[spec.field] as number;
  const dirty = value !== def;

  const onChange = (next: number) => {
    if (!editable) return;
    if (Number.isNaN(next)) return;
    const clamped = Math.min(spec.max, Math.max(spec.min, next));
    configStore.set(spec.field, clamped as PlanningConfig[typeof spec.field]);
  };

  const startRadiusPreview = () => {
    if (!spec.previewRadiusTier) return;
    setRenderRadiusPreviewTier(spec.previewRadiusTier);
    const clear = () => setRenderRadiusPreviewTier(null);
    window.addEventListener("pointerup", clear, { once: true });
    window.addEventListener("pointercancel", clear, { once: true });
  };

  const sliderId = `cfg-${spec.field}`;

  return (
    <div className="dev-controls-tunable-row">
      <label htmlFor={sliderId} className="dev-controls-tunable-label">
        {spec.label}
      </label>
      <div className="dev-controls-tunable-controls">
        <input
          id={sliderId}
          type="range"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={value}
          disabled={!editable}
          onPointerDown={startRadiusPreview}
          onChange={(e) => onChange(Number(e.target.value))}
          className="dev-controls-tunable-slider"
          aria-label={`${spec.label} slider`}
        />
        <input
          type="number"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={value}
          disabled={!editable}
          onChange={(e) => onChange(Number(e.target.value))}
          className="dev-controls-input"
          aria-label={`${spec.label} value`}
        />
        {editable && dirty ? (
          <button
            type="button"
            className="dev-controls-reset"
            title={`Reset to default (${def})`}
            aria-label={`Reset ${spec.label}`}
            onClick={() => configStore.reset(spec.field)}
          >
            ↩
          </button>
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

/**
 * The four `CpuCache` knobs. Unlike everything above them these are
 * **session-scoped**: `updateConfig` is an `Object.assign` onto the live
 * cache instance and nothing persists, so the values are gone on reload.
 * The section says so on screen — the lifetime boundary has to be
 * visible, not just true in the code.
 *
 * The displayed values are read straight off the live config rather than
 * copied into React state, which could only go stale. The cache arrives
 * with the session, which attaches (and can be replaced) independently of
 * this surface, so it comes in as a getter re-read on a slow tick — the
 * same reason the panel this replaced polled.
 */
const CACHE_POLL_INTERVAL_MS = 1000;

function SessionCacheKnobs({
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
  const cpuCache = getCpuCache();
  const values = cpuCache?.getConfig() ?? null;

  return (
    <div className="dev-controls-section">
      <div className="dev-controls-title">Cache (session-scoped)</div>
      <div className="dev-controls-note" role="note">
        Session-scoped: these write the live cache instance and are lost on
        reload — unlike the knobs above, which persist.
      </div>
      {!cpuCache || !values ? (
        <div className="dev-controls-note">No session connected.</div>
      ) : (
        CACHE_KNOBS.map((knob) => {
          const divisor = knob.megabytes ? 1024 * 1024 : 1;
          return (
            <div className="dev-controls-row" key={knob.field}>
              <span>{knob.label}</span>
              <input
                className="dev-controls-input"
                type="number"
                aria-label={knob.label}
                value={Math.round(values[knob.field] / divisor)}
                disabled={!editable}
                onChange={(e) => {
                  if (!editable) return;
                  const shown = Number(e.target.value);
                  if (!(shown > 0)) return;
                  cpuCache.updateConfig({ [knob.field]: shown * divisor });
                  refresh();
                }}
              />
            </div>
          );
        })
      )}
    </div>
  );
}

export function DevControls({
  getCpuCache = () => null,
  editable = import.meta.env.DEV,
  style,
}: {
  /** Live cache for the session-scoped knobs; null when no session is up. */
  getCpuCache?: () => LiveCacheKnobs | null;
  /** Whether the knobs accept edits. Defaults to dev-build-only. */
  editable?: boolean;
  style?: React.CSSProperties;
} = {}) {
  const cfg = usePlanningConfig();
  // Lane offsets default to collapsed — they're a structural knob most
  // users should not be tweaking; surface a warning above them when
  // expanded so the consequences are explicit.
  const [laneOffsetsExpanded, setLaneOffsetsExpanded] = useState(false);

  const warningFor = (field: keyof PlanningConfig): string | null =>
    LANE_ORDER.includes(field) ? laneOrderWarning(cfg, field) : null;

  const allDefaults = (Object.keys(DEFAULT_PLANNING_CONFIG) as (keyof PlanningConfig)[])
    .every((k) => cfg[k] === DEFAULT_PLANNING_CONFIG[k]);

  return (
    <div className="dev-controls" style={style}>
      <div className="dev-controls-content">
        <div className="dev-controls-section">
          <div className="dev-controls-title">Dev controls</div>
          {editable ? (
            <div className="dev-controls-note">
              Live tunables. Each planning change replans on the next frame
              and persists to localStorage.
            </div>
          ) : (
            <div className="dev-controls-note" role="note">
              Read-only in this build: live values shown for inspection;
              editing is a dev-build capability. Reset all still works,
              clearing any persisted knobs.
            </div>
          )}
          {/* Reset-all stays enabled in EVERY build (only individual knob
              edits are dev-gated): knobs persisted by an earlier session
              still steer the planner in prod, and moving toward defaults
              is a safety valve — without it the only recovery from stale
              persisted knobs would be a manual localStorage wipe. */}
          <button
            type="button"
            onClick={() => configStore.reset()}
            disabled={allDefaults}
            className="dev-controls-reset-all"
          >
            Reset all to defaults
          </button>
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
            <button
              type="button"
              className="dev-controls-toggle"
              onClick={() => setLaneOffsetsExpanded((v) => !v)}
              aria-expanded={laneOffsetsExpanded}
              aria-controls="cfg-lane-offsets"
            >
              {laneOffsetsExpanded ? "Hide" : "Show"}
            </button>
          </div>
          {laneOffsetsExpanded && (
            <div id="cfg-lane-offsets">
              <div className="dev-controls-warn" role="note">
                Structural knobs: changing lane offsets reorders the queue
                priorities across the system. The canonical order is
                MINIMAP &lt; DETAIL &lt; PROXY &lt; PREFETCH &lt; COARSE.
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

        <SessionCacheKnobs getCpuCache={getCpuCache} editable={editable} />
      </div>
    </div>
  );
}
