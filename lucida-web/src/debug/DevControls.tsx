/**
 * Dev controls: the one mutation surface for the pipeline. It holds the
 * planning knobs backed by {@link configStore}, persisted to localStorage,
 * and four `CpuCache` knobs that are session-scoped and die on reload. The
 * session-scoped section says so on screen, because controls that silently
 * reset beside ones that don't are a trap.
 *
 * Writes are dev-build only. "Reset all to defaults" works in every build:
 * persisted planning knobs still steer production, and without it recovery is
 * a manual localStorage wipe.
 */

import { ArrowCounterClockwiseIcon, CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { configStore } from "../pipeline/planning/configStore.ts";
import {
  DEFAULT_PLANNING_CONFIG,
  type PlanningConfig,
} from "../pipeline/planning/config.ts";
import type { CpuCacheConfig } from "../pipeline/fetch/index.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { setRenderRadiusPreviewTier } from "./logging.ts";
import "./DevControls.css";

// Per-field UI metadata. The panel renders from these arrays, so a new field
// needs only a row here.

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

/**
 * The four session-scoped `CpuCache` knobs: `updateConfig` assigns onto the
 * live cache and nothing persists. The section says so on screen.
 *
 * Values are read off the live config rather than copied into React state,
 * which could go stale. The session can be replaced independently of this
 * surface, so the cache comes in as a getter re-read on a slow tick.
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
}: {
  /** Live cache for the session-scoped knobs; null when no session is up. */
  getCpuCache?: () => LiveCacheKnobs | null;
  /** Whether the knobs accept edits. Defaults to dev-build-only. */
  editable?: boolean;
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
    <div className="dev-controls">
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
          <Button size="sm" onPress={() => configStore.reset()} isDisabled={allDefaults}>
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
