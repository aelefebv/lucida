/**
 * Register the viewer's controls for the trace driver's scripted steps.
 *
 * A script's scrub, select, contrast, and remove land on the handlers the
 * dimension controls and the layer panel call, its add on the one the
 * add-data dialog calls, and its view read is the share button's capture.
 * The capture surface hides those controls, so a synthesized click has
 * nothing to reach. From the handler on this is the same path a person's
 * input takes, and the recorder hears the input at the control as it does
 * for a person. See `trace/steps.ts` for the seam's side.
 */

import { useEffect, type RefObject } from "react";
import { normalize_dataset_url } from "lucida-core";
import { Axis } from "../axes.ts";
import type { ResolvedLayers } from "../resolvedLayers.ts";
import type { SavedView } from "../savedView/types.ts";
import {
  awaitDatasetOpen,
  datasetIdForSource,
  scrubIndex,
  scrubSolo,
  selectDataset,
  setScriptControls,
  type SelectorState,
} from "../trace/steps.ts";
import type { DatasetState } from "../types.ts";

export interface ScriptControlInputs {
  /** The selectors as the dimension controls see them. */
  selectors: SelectorState;
  /** What each layer shows, for a `c` scrub's starting solo. */
  resolvedLayers: ResolvedLayers;
  /** The handlers the Z and T controls call. */
  setZ(index: number): void;
  setT(index: number): void;
  /** The handler the layer panel's solo calls. */
  setSolo(datasetId: string, channel: number | null): void;
  /** The handlers the layer panel's channel and layer checkboxes call. */
  setChannelVisible(datasetId: string, channel: number, visible: boolean): void;
  setLayerVisible(datasetId: string, visible: boolean): void;
  /** The handler the layer panel's contrast limits call. */
  setChannelContrast(datasetId: string, channel: number, min: number, max: number): void;
  /** The handler the add-data dialog calls with a source URL. */
  openDataset(url: string): void;
  /** The handler the layer panel's remove calls once a person has confirmed. */
  removeDataset(datasetId: string): void;
  /** The server's dataset health, which pairs each source URL with its workspace id. */
  datasetHealth(): Promise<readonly { workspace_dataset_id: string; source_url?: string | null }[]>;
  /** The view as the page would save it, or null before a scene exists. */
  captureView(): SavedView | null;
  /** The dataset a channel step is about when several are open. */
  selectedDatasetId: string | null;
  /** The open datasets, read when a step lands rather than when it is registered. */
  datasetsRef: RefObject<Map<string, DatasetState>>;
}

export function useScriptControls(inputs: ScriptControlInputs): void {
  const { z, t, dimZ, dimT, viewMode } = inputs.selectors;
  const {
    resolvedLayers,
    setZ,
    setT,
    setSolo,
    setChannelVisible,
    setLayerVisible,
    setChannelContrast,
    openDataset,
    removeDataset,
    datasetHealth,
    captureView,
    selectedDatasetId,
    datasetsRef,
  } = inputs;
  useEffect(() => {
    const selectors: SelectorState = { z, t, dimZ, dimT, viewMode };
    const channelCountOf = (datasetId: string): number =>
      datasetsRef.current?.get(datasetId)?.manifest?.images[0]?.multiscale.levels[0]?.shape[Axis.C] ?? 1;
    setScriptControls({
      view: captureView,
      scrub: (axis, count) => {
        if (axis === "c") {
          const open = Array.from(datasetsRef.current?.keys() ?? []);
          const datasetId = selectDataset(selectedDatasetId, open);
          if (datasetId === null) {
            return { applied: false, reason: "no dataset is in hand for a channel scrub" };
          }
          const solo = resolvedLayers.get(datasetId)?.solo ?? null;
          const landing = scrubSolo(solo, channelCountOf(datasetId), count);
          if ("refused" in landing) return { applied: false, reason: landing.refused };
          setSolo(datasetId, landing.solo);
          return { applied: true, reason: null };
        }
        const landing = scrubIndex(selectors, axis, count);
        if ("refused" in landing) return { applied: false, reason: landing.refused };
        ({ z: setZ, t: setT })[axis](landing.index);
        return { applied: true, reason: null };
      },
      select: (target, visible) => {
        const open = Array.from(datasetsRef.current?.keys() ?? []);
        if ("layer" in target) {
          if (!open.includes(target.layer)) {
            return { applied: false, reason: `no layer ${target.layer} is open` };
          }
          setLayerVisible(target.layer, visible);
          return { applied: true, reason: null };
        }
        const datasetId = selectDataset(selectedDatasetId, open);
        if (datasetId === null) {
          return { applied: false, reason: "no dataset is in hand for a channel select" };
        }
        const channels = channelCountOf(datasetId);
        if (target.channel >= channels) {
          return {
            applied: false,
            reason: `${datasetId} has ${channels} channel(s), so there is no channel ${target.channel}`,
          };
        }
        setChannelVisible(datasetId, target.channel, visible);
        return { applied: true, reason: null };
      },
      contrast: (channel, min, max) => {
        const open = Array.from(datasetsRef.current?.keys() ?? []);
        const datasetId = selectDataset(selectedDatasetId, open);
        if (datasetId === null) {
          return { applied: false, reason: "no dataset is in hand for a contrast step" };
        }
        const channels = channelCountOf(datasetId);
        if (channel >= channels) {
          return {
            applied: false,
            reason: `${datasetId} has ${channels} channel(s), so there is no channel ${channel}`,
          };
        }
        setChannelContrast(datasetId, channel, min, max);
        return { applied: true, reason: null };
      },
      addDataset: async (url, timeoutMs) => {
        const canonical = normalize_dataset_url(url.trim());
        const open = new Set(datasetsRef.current?.keys() ?? []);
        // Without health the add still goes ahead, as the dialog's would.
        const existing = await datasetHealth()
          .then((health) => datasetIdForSource(canonical, health, normalize_dataset_url))
          .catch(() => null);
        if (existing !== null && open.has(existing)) {
          return { applied: false, reason: `${canonical} is already open as ${existing}` };
        }
        // Waiting from before the send, so an answer that comes back at once is not missed.
        const outcome = awaitDatasetOpen(canonical, open, timeoutMs);
        openDataset(canonical);
        return outcome;
      },
      removeDataset: async (url) => {
        const canonical = normalize_dataset_url(url.trim());
        let datasetId: string | null;
        try {
          datasetId = datasetIdForSource(canonical, await datasetHealth(), normalize_dataset_url);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          return { applied: false, reason: `the page could not read which dataset ${canonical} is: ${why}` };
        }
        if (datasetId === null || !datasetsRef.current?.has(datasetId)) {
          return { applied: false, reason: `no dataset opened from ${canonical} is open` };
        }
        removeDataset(datasetId);
        return { applied: true, reason: null };
      },
    });
    return () => setScriptControls(null);
  }, [
    z, t, dimZ, dimT, viewMode, resolvedLayers,
    setZ, setT, setSolo, setChannelVisible, setLayerVisible,
    setChannelContrast, openDataset, removeDataset, datasetHealth,
    captureView, selectedDatasetId, datasetsRef,
  ]);
}
