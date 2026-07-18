/**
 * Realtime planning-config panel — tab body for the DebugPanel "Config"
 * entry. Renders the live {@link configStore} as sections of chunk
 * planning controls with a slider + number
 * input + per-field reset arrow per row, plus a "Reset all to defaults"
 * button at the top.
 *
 * The store is the source of truth — every render reads from
 * `configStore.get()` and every edit goes through `configStore.set` /
 * `configStore.reset`. The orchestrator subscribes to the same store
 * and clears its epoch cache on each change so the next frame
 * replans from the new values.
 *
 * Every knob here is a developer planning tunable, and edits persist to
 * localStorage where the planner reads them on every tick — so writes
 * are dev-build only (`editable` defaults to `import.meta.env.DEV`). In
 * production builds the tab renders the live values read-only: still
 * useful for inspecting what the planner is running with, but not a
 * control surface. One exception: "Reset all to defaults" works in every
 * build — persisted knobs from an earlier session still apply in prod,
 * and resetting *toward* defaults is a safety valve, not a steering
 * control; without it the only recovery from stale persisted knobs is a
 * manual localStorage wipe. The one planning-config field that IS
 * product config, `depthBiasView`, is deliberately not rendered here —
 * it lives in the main 3-D view UI (components/FocalDepthControl.tsx)
 * and stays writable in every build.
 *
 * Cross-constraint warnings (warn but allow): lane offsets that invert
 * the canonical priority order (MINIMAP < DETAIL < PREFETCH < COARSE). Shown under the
 *     affected lane field.
 */

import { useSyncExternalStore, useState } from "react";
import { configStore } from "../pipeline/planning/configStore.ts";
import {
  DEFAULT_PLANNING_CONFIG,
  type PlanningConfig,
} from "../pipeline/planning/config.ts";
import {
  setRenderRadiusPreviewTier,
  type RenderRadiusPreviewTier,
} from "./logging.ts";

// Single source of truth for the per-field UI metadata: label, slider
// bounds + step, and the section grouping. The render loop walks these
// arrays — new fields show up just by adding a row here.

interface TunableSpec {
  field: keyof PlanningConfig;
  label: string;
  /** Static lower bound. */
  min: number;
  max: number;
  step: number;
  previewRadiusTier?: RenderRadiusPreviewTier;
}

const REQUEST_POLICY: TunableSpec[] = [
  { field: "prefetchDepth", label: "Prefetch depth", min: 0, max: 5, step: 1 },
];

const PRIORITY_WEIGHTS: TunableSpec[] = [
  { field: "importanceWeight", label: "Importance weight", min: 10, max: 2000, step: 10 },
  { field: "distanceWeight", label: "Distance weight", min: 1, max: 100, step: 1 },
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
];

const LANE_OFFSETS: TunableSpec[] = [
  { field: "minimapLaneOffset", label: "MINIMAP lane offset", min: 0, max: 5000, step: 50 },
  { field: "detailLaneOffset", label: "DETAIL lane offset", min: 0, max: 5000, step: 50 },
  { field: "prefetchLaneOffset", label: "PREFETCH lane offset", min: 0, max: 5000, step: 50 },
  { field: "coarseLaneOffset", label: "COARSE lane offset", min: 0, max: 5000, step: 50 },
];

// Canonical lane priority order, lowest offset (most urgent) first. Used
// to detect inversions in the lane-offsets section.
const LANE_ORDER: (keyof PlanningConfig)[] = [
  "minimapLaneOffset",
  "detailLaneOffset",
  "prefetchLaneOffset",
  "coarseLaneOffset",
];

/**
 * Returns a warning when a given lane offset breaks the canonical order
 * MINIMAP < DETAIL < PREFETCH < COARSE. The warning attaches
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
    ...REQUEST_POLICY,
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
 * The row is the same shape for all three sections; per-section
 * variation lives entirely in the `TunableSpec` table above.
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
  const minActive = spec.min;
  const dirty = value !== def;

  const onChange = (next: number) => {
    if (!editable) return;
    if (Number.isNaN(next)) return;
    const clamped = Math.min(spec.max, Math.max(minActive, next));
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
          disabled={!editable}
          onPointerDown={startRadiusPreview}
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
          disabled={!editable}
          onChange={(e) => onChange(Number(e.target.value))}
          className="debug-config-input"
          aria-label={`${spec.label} value`}
        />
        {editable && dirty ? (
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

export function ConfigTab({
  editable = import.meta.env.DEV,
}: {
  /** Whether the knobs accept edits. Defaults to dev-build-only. */
  editable?: boolean;
} = {}) {
  const cfg = usePlanningConfig();
  // Lane offsets default to collapsed — they're a structural knob most
  // users should not be tweaking; surface a warning above them when
  // expanded so the consequences are explicit.
  const [laneOffsetsExpanded, setLaneOffsetsExpanded] = useState(false);

  const warningFor = (field: keyof PlanningConfig): string | null => {
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
        {editable ? (
          <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: 6 }}>
            Live tunables. Each change replans on the next frame and
            persists to localStorage.
          </div>
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: 6 }} role="note">
            Read-only in this build: live planner values shown for
            inspection; editing is a dev-build capability. Reset all
            still works, clearing any persisted knobs.
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
          className="debug-config-reset-all"
        >
          Reset all to defaults
        </button>
      </div>

      <div className="debug-section">
        <div className="debug-title">Request policy</div>
        {REQUEST_POLICY.map((spec) => (
          <TunableRow
            key={spec.field}
            spec={spec}
            cfg={cfg}
            warning={warningFor(spec.field)}
            editable={editable}
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
            editable={editable}
          />
        ))}
      </div>

      <div className="debug-section">
        <div className="debug-title">Residency budgets</div>
        <div style={{ color: "var(--text-muted)", fontSize: "0.75rem", marginBottom: 6 }}>
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
    </>
  );
}
