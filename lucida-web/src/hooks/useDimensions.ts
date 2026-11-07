import { useCallback, useEffect, useState } from "react";
import type { WasmScene } from "lucida-core";
import { Axis } from "../axes.ts";
import { applyViewportCommand } from "../applyAndSend.ts";
import { invalidateSelection } from "../invalidation.ts";
import type { RenderLoop } from "../renderLoop.ts";
import { getViewportClass } from "../theme/viewport.ts";
import type { DatasetState, ViewMode } from "../types.ts";
import type { BridgeCallbacks } from "./useDatasetSettings.ts";

interface Params {
  wasmSceneRef: React.RefObject<WasmScene | null>;
  wasmScene: WasmScene | null;
  selectedDatasetId: string | null;
  datasetsRef: React.RefObject<Map<string, DatasetState>>;
  datasetsVersion: number;
  bridgeCallbacksRef: React.RefObject<BridgeCallbacks>;
  loopRef: React.RefObject<RenderLoop | null>;
}

export function useDimensions({
  wasmSceneRef,
  wasmScene,
  selectedDatasetId,
  datasetsRef,
  datasetsVersion,
  bridgeCallbacksRef,
  loopRef,
}: Params) {
  const [z, setZ] = useState(0);
  const [c, setC] = useState(0);
  const [t, setT] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("2d");
  const [multiChannel, setMultiChannel] = useState(false);

  // Slider ranges are the union across all datasets. `datasetsVersion`
  // re-renders on every Map mutation, so reading the ref here is current.
  let dimZ = 1, dimC = 1, dimT = 1;
  void datasetsVersion;
  // eslint-disable-next-line react-hooks/refs
  for (const ds of datasetsRef.current.values()) {
    const shape = ds.manifest.images[0].multiscale.levels[0].shape; // [T, C, Z, Y, X]
    dimZ = Math.max(dimZ, shape[Axis.Z]);
    dimC = Math.max(dimC, shape[Axis.C]);
    dimT = Math.max(dimT, shape[Axis.T]);
  }

  // Saved-view clamping needs T/C counts, which the scene can't supply. An
  // unloaded dataset returns `{}`, leaving every axis unclamped.
  const dimensionExtentsFor = useCallback(
    (datasetId: string): { z?: number; t?: number; c?: number } => {
      const ds = datasetsRef.current.get(datasetId);
      const shape = ds?.manifest.images[0]?.multiscale.levels[0]?.shape;
      if (!shape) return {};
      return { z: shape[Axis.Z], t: shape[Axis.T], c: shape[Axis.C] };
    },
    [datasetsRef],
  );

  // Label names in manifest order, which per-label settings index into. Saved
  // views key per-label settings by name and occurrence against these, so a
  // changed label list still lands each setting on the right label.
  // `undefined` leaves per-label handling positional.
  const labelNamesFor = useCallback(
    (datasetId: string): string[] | undefined => {
      const ds = datasetsRef.current.get(datasetId);
      const labels = ds?.manifest.labels;
      if (!labels || labels.length === 0) return undefined;
      return labels.map((l) => l.name);
    },
    [datasetsRef],
  );

  // Clamp z/c/t when the union shrinks. This syncs with external state, so
  // setState in the effect is intended.
  useEffect(() => {
    const scene = wasmSceneRef.current;
    let clamped = false;
    if (z >= dimZ) {
      const newZ = dimZ - 1;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setZ(newZ);
      if (scene) applyViewportCommand(scene, { type: "set_z", z: newZ });
      clamped = true;
    }
    if (c >= dimC) {
      const newC = dimC - 1;
      setC(newC);
      if (scene) applyViewportCommand(scene, { type: "set_c", c: newC });
      clamped = true;
    }
    if (t >= dimT) {
      const newT = dimT - 1;
      setT(newT);
      if (scene) applyViewportCommand(scene, { type: "set_t", t: newT });
      clamped = true;
    }
    if (clamped) {
      bridgeCallbacksRef.current.emitPresence();
    }
    // Deliberately omit z/c/t/wasmSceneRef/bridgeCallbacksRef: the clamp
    // is a one-shot reaction to dim shrinkage, not a continuous sync.
  }, [dimZ, dimC, dimT]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleViewModeToggle = useCallback(() => {
    const next = viewMode === "2d" ? "3d" : "2d";
    setViewMode(next);
    bridgeCallbacksRef.current.breakFollow();
    if (wasmScene) {
      applyViewportCommand(wasmScene, { type: next === "3d" ? "set_mode_arcball" : "set_mode_slice" });
      if (next === "2d" && selectedDatasetId) {
        const dsManifest = datasetsRef.current.get(selectedDatasetId)?.manifest;
        if (dsManifest) {
          const shapeX = dsManifest.images[0].multiscale.levels[0].shape[Axis.X];
          const shapeY = dsManifest.images[0].multiscale.levels[0].shape[Axis.Y];
          applyViewportCommand(wasmScene, { type: "set_center", x: shapeX / 2, y: shapeY / 2 });
        }
      }
      // Each mode starts from a fixed camera: 3D looks at the unit cube's
      // middle from a set distance, and 2D shows one sample per device pixel.
      // On a narrow or tall canvas at a phone's pixel ratio that is a corner
      // of the volume or a small image, so below desktop widths the new mode
      // frames the data instead.
      const fitId = selectedDatasetId ?? datasetsRef.current.keys().next().value;
      if (getViewportClass() !== "desktop" && fitId) {
        try {
          wasmScene.fit_camera_to_dataset_bounds(fitId);
        } catch {
          // A dataset with nothing loaded yet has no bounds; the fixed camera stays.
        }
      }
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [viewMode, wasmScene, selectedDatasetId, datasetsRef, bridgeCallbacksRef]);

  // The recorder hears the scrub here, at the control, not where the value
  // reaches the render loop. A saved-view apply and a followed peer move the
  // same selectors, and neither is an input.
  const handleZChange = useCallback((v: number) => {
    setZ(v);
    bridgeCallbacksRef.current.breakFollow();
    loopRef.current?.markInput("scrub");
    const scene = wasmSceneRef.current;
    if (scene) {
      applyViewportCommand(scene, { type: "set_z", z: v });
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [wasmSceneRef, bridgeCallbacksRef, loopRef]);

  const handleCChange = useCallback((v: number) => {
    setC(v);
    bridgeCallbacksRef.current.breakFollow();
    loopRef.current?.markInput("scrub");
    const scene = wasmSceneRef.current;
    if (scene) {
      applyViewportCommand(scene, { type: "set_c", c: v });
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [wasmSceneRef, bridgeCallbacksRef, loopRef]);

  const handleTChange = useCallback((v: number) => {
    setT(v);
    bridgeCallbacksRef.current.breakFollow();
    loopRef.current?.markInput("scrub");
    const scene = wasmSceneRef.current;
    if (scene) {
      applyViewportCommand(scene, { type: "set_t", t: v });
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [wasmSceneRef, bridgeCallbacksRef, loopRef]);

  // Solo is single-channel mode on the soloed channel; the composite is
  // multi-channel mode. Both change which channels are shown, so a select.
  const applyChannelMode = useCallback((multi: boolean, channel: number | null) => {
    if (channel !== null) setC(channel);
    setMultiChannel(multi);
    bridgeCallbacksRef.current.breakFollow();
    const scene = wasmSceneRef.current;
    if (scene) {
      if (channel !== null) applyViewportCommand(scene, { type: "set_c", c: channel });
      applyViewportCommand(scene, { type: "set_multi_channel", enabled: multi });
      invalidateSelection(loopRef.current);
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [wasmSceneRef, bridgeCallbacksRef, loopRef]);

  const soloChannel = !multiChannel && dimC > 1 ? c : null;

  /** Show one channel alone, or return to the composite when it already is. */
  const handleSoloChannel = useCallback((channel: number) => {
    if (soloChannel === channel) applyChannelMode(true, null);
    else applyChannelMode(false, channel);
  }, [soloChannel, applyChannelMode]);

  const handleShowAllChannels = useCallback(() => {
    applyChannelMode(true, null);
  }, [applyChannelMode]);

  // A multichannel image opens as a composite. Only the first one switches
  // the mode, so opening another never undoes a solo, and this runs as the
  // dataset registers, before a saved view or a followed peer applies its own
  // mode on top. The scene's default stays single-channel, because a view
  // recorded without the flag means single-channel.
  const handleDatasetRegistered = useCallback((datasetId: string) => {
    const datasets = datasetsRef.current;
    const ds = datasets.get(datasetId);
    if (!ds || channelCountOf(ds) <= 1) return;
    for (const [id, other] of datasets) {
      if (id !== datasetId && channelCountOf(other) > 1) return;
    }
    const scene = wasmSceneRef.current;
    if (!scene || scene.multi_channel()) return;
    applyViewportCommand(scene, { type: "set_multi_channel", enabled: true });
    setMultiChannel(true);
    invalidateSelection(loopRef.current);
    bridgeCallbacksRef.current.emitPresence();
  }, [datasetsRef, wasmSceneRef, loopRef, bridgeCallbacksRef]);

  return {
    z, c, t, setZ, setC, setT,
    viewMode, setViewMode,
    multiChannel, setMultiChannel,
    dimZ, dimC, dimT,
    dimensionExtentsFor,
    labelNamesFor,
    soloChannel,
    handleViewModeToggle,
    handleZChange, handleCChange, handleTChange,
    handleSoloChannel, handleShowAllChannels, handleDatasetRegistered,
  };
}

function channelCountOf(ds: DatasetState): number {
  return ds.manifest.images[0]?.multiscale.levels[0]?.shape[Axis.C] ?? 1;
}
