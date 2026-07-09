import { useEffect, useRef } from "react";
import type { DatasetManifest } from "../manifestTypes.ts";
import type { ViewMode } from "../types.ts";
import {
  planLabelRescue,
  type LabelViewSetting,
} from "../pipeline/planning/labelRequests.ts";

interface Params {
  /** The currently-open dataset ids to consider for a fresh-open rescue. */
  openDatasetIds: readonly string[];
  /** Gate: only run once the transport is GENUINELY ready (the same signal the
   *  seed-open is gated on), so we don't rescue against a half-open session.
   *  While `false` the effect is a no-op that DOES NOT latch, so the first ready
   *  evaluation for each dataset still happens. */
  ready: boolean;
  /** Active view mode — selects the caps (`3d`→volume, else slice) the rescue
   *  reasons about. Captured at each dataset's first ready evaluation; a later
   *  mode switch does NOT re-arm the one-shot. */
  viewMode: ViewMode;
  /** The dataset's manifest, or undefined until it has loaded. */
  manifestOf: (id: string) => DatasetManifest | undefined;
  /** The dataset's persisted per-label settings, or undefined. */
  labelSettingsOf: (id: string) => LabelViewSetting[] | undefined;
  /** Reveal (persist visible) the rescued label — a LOCAL view correction. */
  emitRescue: (datasetId: string, labelIndex: number) => void;
}

/**
 * One-shot, per-dataset repair so a freshly-opened dataset never shows an "on"
 * label overlay it can't draw in the OPEN view mode.
 *
 * The (mode-agnostic) seed can mark a label visible that is ineligible under the
 * web's mode-specific caps while a later label IS eligible — the dataset would
 * then open with its panel checkbox "on" but nothing drawn. This detects that
 * exact case ({@link planLabelRescue}) at fresh open and reveals the first
 * mode-eligible label so the checkbox and the drawn overlay agree.
 *
 * The per-datasetId latch (`firedRef`) is the load-bearing property: the rescue
 * fires at most once per dataset, at its FIRST ready evaluation — so a later
 * 2D/3D mode switch or a re-render NEVER re-fires and NEVER re-reveals a label
 * the user has since hidden. The latch is durable across mode switches (App does
 * not remount on a toggle), which is why it lives here at the app level. Latching
 * happens whether or not a rescue was needed; a dataset is skipped WITHOUT
 * latching while it is genuinely not-ready, not-yet-loaded, or has labels whose
 * settings the scene has not applied yet, so it is reconsidered once it is fully
 * open. The latch is PRUNED when a dataset closes, so closing then reopening a
 * dataset earns a fresh rescue rather than staying latched forever.
 */
export function useLabelRescueOnOpen({
  openDatasetIds,
  ready,
  viewMode,
  manifestOf,
  labelSettingsOf,
  emitRescue,
}: Params): void {
  const firedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Prune the latch for datasets that have closed, so a reopened dataset is
    // rescued afresh (the latch is per-datasetId and durable, but must not
    // outlive the dataset itself). Only prune against a genuinely non-empty
    // list: the open set is derived from the live scene and momentarily reads
    // empty during a scene reinit or getter fault, and a transient empty must
    // never wipe every latch — that would re-arm the one-shot and let the
    // rescue re-reveal a label the user has since hidden. An empty list only
    // ever loses latches, so skipping the prune there is safe. Snapshot the
    // keys — we mutate while scanning.
    if (openDatasetIds.length > 0) {
      const open = new Set(openDatasetIds);
      for (const id of [...firedRef.current]) {
        if (!open.has(id)) firedRef.current.delete(id);
      }
    }

    // Not-ready deferral must not burn the one-shot — return before any latch.
    if (!ready) return;
    for (const id of openDatasetIds) {
      if (firedRef.current.has(id)) continue;
      const manifest = manifestOf(id);
      // Wait for the manifest without latching — the dataset isn't fully open.
      if (manifest === undefined) continue;
      const labelSettings = labelSettingsOf(id);
      // Defensive: a manifest can list labels a tick before the scene has applied
      // their settings. Latching now would burn the one-shot against empty
      // settings (planLabelRescue can't reason about them) and the dataset would
      // never be rescued. Wait a tick WITHOUT latching until the settings read.
      const hasLabels = !!manifest.labels && manifest.labels.length > 0;
      if (hasLabels && (labelSettings === undefined || labelSettings.length === 0)) continue;
      // Latch at the first fully-ready evaluation (whether or not it rescues), so
      // the rescue is fresh-open-only.
      firedRef.current.add(id);
      const mode = viewMode === "3d" ? "volume" : "slice";
      const idx = planLabelRescue(manifest, labelSettings, mode);
      if (idx !== null) emitRescue(id, idx);
    }
  }, [openDatasetIds, ready, viewMode, manifestOf, labelSettingsOf, emitRescue]);
}
