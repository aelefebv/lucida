/**
 * The HUD legend: the overlay toggles, in every build.
 *
 * The overlays are product surfaces (ADR 0052 as amended), so the toggles
 * that used to sit in the dev-gated Dev controls panel live here, with no
 * editable gate. They write through the same registry and the same browser
 * storage key as before, so a setting made before the move survives it.
 *
 * The churn toggle states its window beside its name, because a fetch count
 * without a denominator is not a measurement: the tint counts fetches over
 * the interval in progress, and the legend says how long that has been.
 */

import { useEffect, useState } from "react";

import {
  DEBUG_OVERLAYS,
  isOverlayEnabled,
  onOverlaysChanged,
  setOverlayEnabled,
  type DebugOverlay,
} from "../debug/logging.ts";
import { churnWindowLabel } from "../debug/overlayDrawList.ts";
import { traceRecorder } from "../trace/recorder.ts";

const OVERLAY_LABELS: Record<DebugOverlay, string> = {
  groupModes: "group modes",
  chunkGrid: "chunk grid",
  chunkTier: "tier",
  renderRadius: "render radius",
  cachedTier: "cached tier",
  plannedRank: "planned rank",
  phaseColor: "phase",
  churnTint: "churn",
};

const OVERLAY_DESCRIPTIONS: Record<DebugOverlay, string> = {
  groupModes: "A badge per group: detail and coarse chunks available against wanted.",
  chunkGrid: "The chunk grid for every visible tile, colored by status: cached, in flight, planned. In volume mode, each chunk box as a wireframe in the same colors. Capped at about 600 cells per tick.",
  chunkTier: "Color tile chunks by the displayed tier: detail green, coarse yellow, missing red. Needs the chunk grid.",
  renderRadius: "The detail and coarse render-radius boundary: circles in slice mode, projected rings in volume mode.",
  cachedTier: "Color cached chunks by eviction tier: active bright green, demoted pale sage, prefetch teal. Needs the chunk grid.",
  plannedRank: "Color planned chunks by queue rank: top of the queue bright orange, bottom dim red, gray when not pending. Needs the chunk grid.",
  phaseColor:
    "Color each chunk by the phase its newest row is in, from the same palette the timeline uses. A chunk with no row in the open interval is left unpainted and says so. Hover a chunk for its phase, queue rank, and age. Shows the chunk grid.",
  churnTint:
    "Tint each chunk by how many times it was fetched in the open interval: one fetch faint, two amber, three orange, four or more red. Shows the chunk grid.",
};

/** The window is shown to a tenth of a second, so once a second keeps it current. */
const WINDOW_POLL_MS = 1_000;

/**
 * The overlay registry is a module-level set with no stable snapshot for
 * `useSyncExternalStore`, so a counter bumped on change re-renders instead.
 * It also picks up a flip from another tab.
 */
function useOverlayVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => onOverlaysChanged(() => setVersion((v) => v + 1)), []);
  return version;
}

/** Where the legend reads the churn window. The recorder, unless a test hands in another. */
export interface ChurnWindowSource {
  readonly openIntervalMs: number | null;
}

function useChurnWindow(source: ChurnWindowSource): number | null {
  const [windowMs, setWindowMs] = useState<number | null>(() => source.openIntervalMs);
  useEffect(() => {
    const read = () => setWindowMs(source.openIntervalMs);
    read();
    const timer = setInterval(read, WINDOW_POLL_MS);
    return () => clearInterval(timer);
  }, [source]);
  return windowMs;
}

export interface HudLegendProps {
  /** Where the churn window comes from. Defaults to the page's recorder. */
  windowSource?: ChurnWindowSource;
}

export function HudLegend({ windowSource = traceRecorder }: HudLegendProps) {
  useOverlayVersion();
  const windowMs = useChurnWindow(windowSource);
  return (
    <div className="hud-legend" role="group" aria-label="Overlays" data-testid="hud-legend">
      <span className="hud-legend-title">overlays</span>
      {DEBUG_OVERLAYS.map((name) => (
        <label key={name} className="hud-legend-toggle" title={OVERLAY_DESCRIPTIONS[name]}>
          <input
            type="checkbox"
            aria-label={name}
            checked={isOverlayEnabled(name)}
            onChange={() => setOverlayEnabled(name, !isOverlayEnabled(name))}
          />
          {OVERLAY_LABELS[name]}
          {name === "churnTint" && (
            <span className="hud-legend-window" data-testid="hud-legend-churn-window">
              {churnWindowLabel(windowMs)}
            </span>
          )}
        </label>
      ))}
    </div>
  );
}
