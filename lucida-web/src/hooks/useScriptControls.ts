/**
 * Register the viewer's controls for the trace driver's scripted steps.
 *
 * A script's scrub, select, contrast, and remove land on the handlers the
 * dimension controls and the layer panel call, its add on the one the
 * add-data dialog calls, its swipe and blink on the comparison controls,
 * and its view read is the share button's capture.
 * The capture surface hides those controls, so a synthesized click has
 * nothing to reach. From the handler on this is the same path a person's
 * input takes, and the recorder hears the input at the control as it does
 * for a person. See `trace/steps.ts` for the seam's side.
 */

import { useEffect, type RefObject } from "react";
import { normalize_dataset_url } from "lucida-core";
import { Axis } from "../axes.ts";
import { lineUpReason, type CompareMode, type ComparisonActions } from "../comparison.ts";
import type { ResolvedLayers } from "../resolvedLayers.ts";
import type { SavedView } from "../savedView/types.ts";
import type { ViewLayoutActions } from "../viewLayout.ts";
import { unlinkableReason } from "../viewLinks.ts";
import {
  awaitDatasetOpen,
  comparisonPair,
  datasetIdForSource,
  scrubIndex,
  scrubSolo,
  selectDataset,
  setScriptControls,
  type SelectorState,
  type StepOutcome,
} from "../trace/steps.ts";
import type { DatasetState } from "../types.ts";
import type { SlicePlane } from "../renderer/slicePlane.ts";

export interface ScriptControlInputs {
  /** The selectors as the dimension controls see them. */
  selectors: SelectorState;
  /** What each layer shows, for a `c` scrub's starting solo. */
  resolvedLayers: ResolvedLayers;
  /** The handlers the cut (Z, or Y or X in a side view) and T controls call. */
  setCut(index: number): void;
  setT(index: number): void;
  /** The handler the slice plane toggle calls. */
  setSlicePlane(plane: SlicePlane): void;
  /** The handler the layer panel's solo calls. */
  setSolo(datasetId: string, channel: number | null): void;
  /** The handlers the layer panel's channel and layer checkboxes call. */
  setChannelVisible(datasetId: string, channel: number, visible: boolean): void;
  setLayerVisible(datasetId: string, visible: boolean): void;
  /** The handler the layer panel's label checkboxes call. */
  setLabelVisible(datasetId: string, label: number, visible: boolean): void;
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
  /** What the comparison controls call. */
  comparison: ComparisonActions;
  /** What the layout controls call. */
  viewLayout: ViewLayoutActions;
  /** The dataset a channel step is about when several are open. */
  selectedDatasetId: string | null;
  /** The open datasets, read when a step lands rather than when it is registered. */
  datasetsRef: RefObject<Map<string, DatasetState>>;
}

export function useScriptControls(inputs: ScriptControlInputs): void {
  const { z, t, dimZ, dimT, viewMode, slicePlane, cutIndex, dimCut } = inputs.selectors;
  const {
    resolvedLayers,
    setCut,
    setT,
    setSlicePlane,
    setSolo,
    setChannelVisible,
    setLayerVisible,
    setLabelVisible,
    setChannelContrast,
    openDataset,
    removeDataset,
    datasetHealth,
    captureView,
    comparison,
    viewLayout,
    selectedDatasetId,
    datasetsRef,
  } = inputs;
  useEffect(() => {
    const selectors: SelectorState = { z, t, dimZ, dimT, viewMode, slicePlane, cutIndex, dimCut };
    const channelCountOf = (datasetId: string): number =>
      datasetsRef.current?.get(datasetId)?.manifest?.images[0]?.multiscale.levels[0]?.shape[Axis.C] ?? 1;
    // Shows the comparison in `mode`, starting one when there is none or
    // `withUrl` names a dataset it doesn't hold. A refusal, or null.
    const compareIn = async (mode: CompareMode, withUrl: string | null): Promise<StepOutcome | null> => {
      const open = new Set(datasetsRef.current?.keys() ?? []);
      let withId: string | null = null;
      if (withUrl !== null) {
        const canonical = normalize_dataset_url(withUrl.trim());
        try {
          withId = datasetIdForSource(canonical, await datasetHealth(), normalize_dataset_url);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          return { applied: false, reason: `the page could not read which dataset ${canonical} is: ${why}` };
        }
        if (withId === null || !open.has(withId)) {
          return { applied: false, reason: `no dataset opened from ${canonical} is open` };
        }
      }
      const current = comparison.current();
      if (current && (withId === null || withId === current.a || withId === current.b)) {
        if (current.mode !== mode) comparison.setMode(mode);
        return null;
      }
      // The panel lists the layers last drawn first.
      const panelOrder = [...resolvedLayers.keys()].filter((id) => open.has(id)).reverse();
      const pair = comparisonPair(selectedDatasetId, panelOrder, withId);
      if ("refused" in pair) return { applied: false, reason: pair.refused };
      const why = lineUpReason(comparison.start(pair.a, pair.b, mode), (id) => id);
      return why === null ? null : { applied: false, reason: why };
    };
    setScriptControls({
      view: captureView,
      comparison: comparison.current,
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
        (axis === "t" ? setT : setCut)(landing.index);
        return { applied: true, reason: null };
      },
      plane: (plane) => {
        if (viewMode === "3d") return { applied: false, reason: "a slice plane is cut in 2D, not in volume mode" };
        if (plane === slicePlane) return { applied: false, reason: `the slice view already cuts ${plane.toUpperCase()}` };
        if (plane !== "xy" && dimZ <= 1) {
          return { applied: false, reason: "the data has one Z plane, so there is no side to cut" };
        }
        setSlicePlane(plane);
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
          return { applied: false, reason: "no dataset is in hand for a channel or label select" };
        }
        if ("label" in target) {
          const labels = datasetsRef.current?.get(datasetId)?.manifest?.labels?.length ?? 0;
          if (target.label >= labels) {
            return {
              applied: false,
              reason: `${datasetId} has ${labels} label(s), so there is no label ${target.label}`,
            };
          }
          setLabelVisible(datasetId, target.label, visible);
          return { applied: true, reason: null };
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
      swipe: async (at, withUrl) => {
        const refused = await compareIn("swipe", withUrl);
        if (refused) return refused;
        if (at !== null) comparison.setDivider(at);
        return { applied: true, reason: null };
      },
      blink: async (withUrl) => {
        const refused = await compareIn("blink", withUrl);
        if (refused) return refused;
        comparison.flip();
        return { applied: true, reason: null };
      },
      views: async (layout, show, keep) => {
        const open = new Set(datasetsRef.current?.keys() ?? []);
        let shown: string[][];
        try {
          const health = await datasetHealth();
          shown = show.map((urls) => urls.map((url) => {
            const canonical = normalize_dataset_url(url.trim());
            const id = datasetIdForSource(canonical, health, normalize_dataset_url);
            if (id === null || !open.has(id)) throw new Error(`no dataset opened from ${canonical} is open`);
            return id;
          }));
        } catch (error) {
          return { applied: false, reason: error instanceof Error ? error.message : String(error) };
        }
        viewLayout.setLayout(layout);
        const views = viewLayout.views();
        if (shown.length > views.length) {
          return { applied: false, reason: `a ${layout} layout has ${views.length} view(s), not ${shown.length}` };
        }
        // Each dataset moves into its view, as a layer dropped on it does, or
        // with `keep` shows there as well, as a layer shown in both views.
        shown.forEach((ids, at) => {
          if (!keep) ids.forEach((id) => viewLayout.move(views[at], id));
          else if (ids.length > 0) viewLayout.add(views[at], ids);
        });
        return { applied: true, reason: null };
      },
      link: async (property, mode) => {
        const links = viewLayout.links();
        if (links === null) return { applied: false, reason: "a link joins two views, and the page shows one" };
        const unlinkable = links.properties.find((link) => link.property === property)?.unlinkable;
        // A property the cameras don't share yet keeps its mode for when they do.
        if (unlinkable === "empty" || unlinkable === "not_yet") {
          return { applied: false, reason: unlinkableReason(property, unlinkable) };
        }
        viewLayout.link(property, mode);
        return { applied: true, reason: null };
      },
    });
    return () => setScriptControls(null);
  }, [
    z, t, dimZ, dimT, viewMode, slicePlane, cutIndex, dimCut, resolvedLayers,
    setCut, setT, setSlicePlane, setSolo, setChannelVisible, setLayerVisible, setLabelVisible,
    setChannelContrast, openDataset, removeDataset, datasetHealth,
    captureView, comparison, viewLayout, selectedDatasetId, datasetsRef,
  ]);
}
