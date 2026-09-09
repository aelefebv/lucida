/**
 * Register the viewer's controls for the trace driver's scripted steps
 * (ADR 0051, as amended).
 *
 * A script's scrub and select land on the handlers the dimension controls
 * and the layer panel call, and its view read is the share button's
 * capture. The capture surface hides those controls, so a synthesized click
 * has nothing to reach. From the handler on this is the same path a person's
 * input takes, and the recorder hears the input at the control as it does
 * for a person. See `trace/steps.ts` for the seam's side.
 */

import { useEffect, type RefObject } from "react";
import type { SavedView } from "../savedView/types.ts";
import { scrubIndex, selectDataset, setScriptControls, type SelectorState } from "../trace/steps.ts";
import type { DatasetState } from "../types.ts";

export interface ScriptControlInputs {
  /** The selectors as the dimension controls see them. */
  selectors: SelectorState;
  /** The handlers the Z, T, and C controls call. */
  setZ(index: number): void;
  setT(index: number): void;
  setC(index: number): void;
  /** The handlers the layer panel's channel and layer checkboxes call. */
  setChannelVisible(datasetId: string, channel: number, visible: boolean): void;
  setLayerVisible(datasetId: string, visible: boolean): void;
  /** The view as the page would save it, or null before a scene exists. */
  captureView(): SavedView | null;
  /** The dataset a channel select is about when several are open. */
  selectedDatasetId: string | null;
  /** The open datasets, read when a select lands rather than when it is registered. */
  datasetsRef: RefObject<Map<string, DatasetState>>;
}

export function useScriptControls(inputs: ScriptControlInputs): void {
  const { z, t, c, dimZ, dimT, dimC, viewMode } = inputs.selectors;
  const {
    setZ,
    setT,
    setC,
    setChannelVisible,
    setLayerVisible,
    captureView,
    selectedDatasetId,
    datasetsRef,
  } = inputs;
  useEffect(() => {
    const selectors: SelectorState = { z, t, c, dimZ, dimT, dimC, viewMode };
    setScriptControls({
      view: captureView,
      scrub: (axis, count) => {
        const landing = scrubIndex(selectors, axis, count);
        if ("refused" in landing) return { applied: false, reason: landing.refused };
        ({ z: setZ, t: setT, c: setC })[axis](landing.index);
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
        if (target.channel >= dimC) {
          return {
            applied: false,
            reason: `${datasetId} has ${dimC} channel(s), so there is no channel ${target.channel}`,
          };
        }
        setChannelVisible(datasetId, target.channel, visible);
        return { applied: true, reason: null };
      },
    });
    return () => setScriptControls(null);
  }, [
    z, t, c, dimZ, dimT, dimC, viewMode,
    setZ, setT, setC, setChannelVisible, setLayerVisible,
    captureView, selectedDatasetId, datasetsRef,
  ]);
}
