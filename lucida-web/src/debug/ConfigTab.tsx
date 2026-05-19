/**
 * Realtime planning-config panel — tab body for the DebugPanel "Config"
 * entry. Renders the live {@link configStore} as three sections (mode
 * thresholds, priority weights, lane offsets) with a slider + number
 * input + per-field reset arrow per row, plus a "Reset all to defaults"
 * button at the top.
 *
 * The store is the source of truth — every render reads from
 * `configStore.get()` and every edit goes through `configStore.set` /
 * `configStore.reset`. The orchestrator subscribes to the same store
 * and clears its epoch cache on each change so the next frame
 * replans from the new values.
 *
 * Cross-constraint warnings (warn but allow):
 *   - `detailThresholdPx <= farThresholdPx + 2*hysteresisPx`: the
 *     middle band collapses; `fields-with-proxy-fallback` becomes
 *     unreachable. Surfaced under the affected field.
 *   - Lane offsets that invert the canonical priority order
 *     (MINIMAP < DETAIL < PROXY < PREFETCH < OVERVIEW). Shown under the
 *     affected lane field.
 */

import { useSyncExternalStore, useState } from "react";
import { configStore } from "../pipeline/planning/configStore.ts";
import {
  DEFAULT_PLANNING_CONFIG,
  type PlanningConfig,
} from "../pipeline/planning/config.ts";

// Single source of truth for the per-field UI metadata: label, slider
// bounds + step, and the section grouping. The render loop walks these
// arrays — new fields show up just by adding a row here.

interface TunableSpec {
  field: keyof PlanningConfig;
  label: string;
  /** Static lower bound; the active min may be tightened (see `dynamicMin`). */
  min: number;
  max: number;
  step: number;
  /**
   * Optional dynamic-min hook so detailThresholdPx can stay above
   * farThresholdPx without baking a hard constraint into the default
   * `min`. Returns the runtime lower bound; the slider clamps to it.
   */
  dynamicMin?: (cfg: PlanningConfig) => number;
}

const MODE_THRESHOLDS: TunableSpec[] = [
  { field: "farThresholdPx", label: "FAR threshold (px)", min: 20, max: 200, step: 1 },
  {
    field: "detailThresholdPx",
    label: "DETAIL threshold (px)",
    min: 30,
    max: 500,
    step: 1,
    dynamicMin: (cfg) => cfg.farThresholdPx + 10,
  },
  { field: "hysteresisPx", label: "Hysteresis (px)", min: 0, max: 30, step: 1 },
  { field: "prefetchDepth", label: "Prefetch depth", min: 0, max: 5, step: 1 },
];

const PRIORITY_WEIGHTS: TunableSpec[] = [
  { field: "importanceWeight", label: "Importance weight", min: 10, max: 2000, step: 10 },
  { field: "distanceWeight", label: "Distance weight", min: 1, max: 100, step: 1 },
  {
    field: "wellProxyPriorityBump",
    label: "Well-proxy priority bump",
    min: 0,
    max: 500,
    step: 5,
  },
];

const RESIDENCY_BUDGETS: TunableSpec[] = [
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
  { field: "overviewLaneOffset", label: "OVERVIEW lane offset", min: 0, max: 5000, step: 50 },
];

// Canonical lane priority order, lowest offset (most urgent) first. Used
// to detect inversions in the lane-offsets section.
const LANE_ORDER: (keyof PlanningConfig)[] = [
  "minimapLaneOffset",
  "detailLaneOffset",
  "proxyLaneOffset",
  "prefetchLaneOffset",
  "coarseLaneOffset",
  "overviewLaneOffset",
];

/**
 * Returns a human warning when the middle mode band collapses, i.e. the
 * upper hysteresis band of FAR overlaps the lower band of DETAIL and
 * `fields-with-proxy-fallback` is no longer reachable. Surface under
 * either contributing field.
 */
function modeBandWarning(cfg: PlanningConfig): string | null {
  if (cfg.detailThresholdPx <= cfg.farThresholdPx + 2 * cfg.hysteresisPx) {
    return (
      "Middle band collapsed: fields-with-proxy-fallback unreachable. " +
      "Raise DETAIL or lower FAR/hysteresis."
    );
  }
  return null;
}

/**
 * Returns a warning when a given lane offset breaks the canonical order
 * MINIMAP < DETAIL < PROXY < PREFETCH < OVERVIEW. The warning attaches
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
    ...MODE_THRESHOLDS,
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

function CoarseDetailToggle({ cfg }: { cfg: PlanningConfig }) {
  const dirty = cfg.coarseDetailEnabled !== DEFAULT_PLANNING_CONFIG.coarseDetailEnabled;
  return (
    <div className="debug-config-tunable-row">
      <label className="debug-config-tunable-label" htmlFor="cfg-coarse-detail-enabled">
        Coarse/detail bridge
      </label>
      <div className="debug-config-tunable-controls">
        <input
          id="cfg-coarse-detail-enabled"
          type="checkbox"
          checked={cfg.coarseDetailEnabled}
          onChange={(e) => configStore.set("coarseDetailEnabled", e.target.checked)}
        />
        {dirty ? (
          <button
            type="button"
            className="debug-config-reset"
            title="Reset to default"
            aria-label="Reset coarse/detail bridge"
            onClick={() => configStore.reset("coarseDetailEnabled")}
          >
            ↩
          </button>
        ) : (
          <span className="debug-config-reset-placeholder" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

/**
 * One tunable row: label + slider + number input + reset arrow (visible
 * only when the value differs from the default) + optional warning line.
 *
 * The row is the same shape for all three sections; per-section
 * variation lives entirely in the `TunableSpec` table above.
 */
function TunableRow({
  spec,
  cfg,
  warning,
}: {
  spec: TunableSpec;
  cfg: PlanningConfig;
  warning: string | null;
}) {
  const value = cfg[spec.field] as number;
  const def = DEFAULT_PLANNING_CONFIG[spec.field] as number;
  const dynamicMin = spec.dynamicMin ? spec.dynamicMin(cfg) : spec.min;
  const minActive = Math.max(spec.min, dynamicMin);
  const dirty = value !== def;

  const onChange = (next: number) => {
    if (Number.isNaN(next)) return;
    const clamped = Math.min(spec.max, Math.max(minActive, next));
    configStore.set(spec.field, clamped as PlanningConfig[typeof spec.field]);
  };

  const sliderId = `cfg-${spec.field}`;

  return (
    <div className="debug-config-tunable-row">
      <label htmlFor={sliderId} className="debug-config-tunable-label">
        {spec.label}
      </label>
      <div className="debug-config-tunable-controls">
        <input
          id={sliderId}
          type="range"
          min={minActive}
          max={spec.max}
          step={spec.step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="debug-config-tunable-slider"
          aria-label={`${spec.label} slider`}
        />
        <input
          type="number"
          min={minActive}
          max={spec.max}
          step={spec.step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="debug-config-input"
          aria-label={`${spec.label} value`}
        />
        {dirty ? (
          <button
            type="button"
            className="debug-config-reset"
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
          <span className="debug-config-reset-placeholder" aria-hidden="true" />
        )}
      </div>
      {warning && (
        <div className="debug-config-warn" role="alert">
          {warning}
        </div>
      )}
    </div>
  );
}

export function ConfigTab() {
  const cfg = usePlanningConfig();
  // Lane offsets default to collapsed — they're a structural knob most
  // users should not be tweaking; surface a warning above them when
  // expanded so the consequences are explicit.
  const [laneOffsetsExpanded, setLaneOffsetsExpanded] = useState(false);

  const modeWarning = modeBandWarning(cfg);
  // Mode-threshold warning attaches to detailThresholdPx (the field most
  // people will recognize as the one to lower); also surface on FAR for
  // discoverability.
  const warningFor = (field: keyof PlanningConfig): string | null => {
    if (field === "farThresholdPx" || field === "detailThresholdPx" || field === "hysteresisPx") {
      return modeWarning;
    }
    if (LANE_ORDER.includes(field)) {
      return laneOrderWarning(cfg, field);
    }
    return null;
  };

  const allDefaults = (Object.keys(DEFAULT_PLANNING_CONFIG) as (keyof PlanningConfig)[])
    .every((k) => cfg[k] === DEFAULT_PLANNING_CONFIG[k]);

  return (
    <>
      <div className="debug-section">
        <div className="debug-title">Planning Config</div>
        <div style={{ color: "#888", fontSize: "0.75rem", marginBottom: 6 }}>
          Live tunables. Each change replans on the next frame and
          persists to localStorage.
        </div>
        <button
          type="button"
          onClick={() => configStore.reset()}
          disabled={allDefaults}
          className="debug-config-reset-all"
        >
          Reset all to defaults
        </button>
      </div>

      <div className="debug-section">
        <div className="debug-title">Mode thresholds</div>
        {MODE_THRESHOLDS.map((spec) => (
          <TunableRow
            key={spec.field}
            spec={spec}
            cfg={cfg}
            warning={warningFor(spec.field)}
          />
        ))}
      </div>

      <div className="debug-section">
        <div className="debug-title">Priority weights</div>
        {PRIORITY_WEIGHTS.map((spec) => (
          <TunableRow
            key={spec.field}
            spec={spec}
            cfg={cfg}
            warning={warningFor(spec.field)}
          />
        ))}
      </div>

      <div className="debug-section">
        <div className="debug-title">Residency budgets</div>
        <CoarseDetailToggle cfg={cfg} />
        {RESIDENCY_BUDGETS.map((spec) => (
          <TunableRow
            key={spec.field}
            spec={spec}
            cfg={cfg}
            warning={warningFor(spec.field)}
          />
        ))}
      </div>

      <div className="debug-section">
        <div className="debug-title" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Lane offsets</span>
          <button
            type="button"
            className="debug-config-toggle"
            onClick={() => setLaneOffsetsExpanded((v) => !v)}
            aria-expanded={laneOffsetsExpanded}
            aria-controls="cfg-lane-offsets"
          >
            {laneOffsetsExpanded ? "Hide" : "Show"}
          </button>
        </div>
        {laneOffsetsExpanded && (
          <div id="cfg-lane-offsets">
            <div className="debug-config-warn" role="note">
              Structural knobs: changing lane offsets reorders the queue
              priorities across the system. The canonical order is
              MINIMAP &lt; DETAIL &lt; PROXY &lt; PREFETCH &lt; COARSE &lt; OVERVIEW.
            </div>
            {LANE_OFFSETS.map((spec) => (
              <TunableRow
                key={spec.field}
                spec={spec}
                cfg={cfg}
                warning={warningFor(spec.field)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
