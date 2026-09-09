/**
 * The HUD legend: the overlay toggles, in every build.
 *
 * The overlays are product surfaces (ADR 0052 as amended), so the toggles
 * that used to sit in the dev-gated Dev controls panel live here, with no
 * editable gate. They write through the same registry and the same browser
 * storage key as before, so a setting made before the move survives it.
 */

import { useEffect, useState } from "react";

import {
  DEBUG_OVERLAYS,
  isOverlayEnabled,
  onOverlaysChanged,
  setOverlayEnabled,
  type DebugOverlay,
} from "../debug/logging.ts";

const OVERLAY_LABELS: Record<DebugOverlay, string> = {
  groupModes: "group modes",
  chunkGrid: "chunk grid",
  chunkTier: "tier",
  renderRadius: "render radius",
  cachedTier: "cached tier",
  plannedRank: "planned rank",
};

const OVERLAY_DESCRIPTIONS: Record<DebugOverlay, string> = {
  groupModes: "A badge per group: detail and coarse chunks available against wanted.",
  chunkGrid: "The chunk grid for every visible tile, colored by status: cached, in flight, planned. Capped at about 600 cells per tick.",
  chunkTier: "Color tile chunks by the displayed tier: detail green, coarse yellow, missing red. Needs the chunk grid.",
  renderRadius: "The detail and coarse render-radius boundary: circles in slice mode, projected rings in volume mode.",
  cachedTier: "Color cached chunks by eviction tier: active bright green, demoted pale sage, prefetch teal. Needs the chunk grid.",
  plannedRank: "Color planned chunks by queue rank: top of the queue bright orange, bottom dim red, gray when not pending. Needs the chunk grid.",
};

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

export function HudLegend() {
  useOverlayVersion();
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
        </label>
      ))}
    </div>
  );
}
