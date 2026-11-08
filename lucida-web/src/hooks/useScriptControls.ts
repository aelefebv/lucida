/**
 * Register the viewer's controls for the trace driver's scripted steps.
 *
 * A script's scrub and select land on the handlers the dimension controls
 * and the layer panel call, and its view read is the share button's
 * capture. The capture surface hides those controls, so a synthesized click
 * has nothing to reach. From the handler on this is the same path a person's
 * input takes, and the recorder hears the input at the control as it does
 * for a person. See `trace/steps.ts` for the seam's side.
 */

import { useEffect, type RefObject } from "react";
import { Axis } from "../axes.ts";
import type { ResolvedLayers } from "../resolvedLayers.ts";
import type { SavedView } from "../savedView/types.ts";
import {
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
    });
    return () => setScriptControls(null);
  }, [
    z, t, dimZ, dimT, viewMode, resolvedLayers,
    setZ, setT, setSolo, setChannelVisible, setLayerVisible,
    captureView, selectedDatasetId, datasetsRef,
  ]);
}
