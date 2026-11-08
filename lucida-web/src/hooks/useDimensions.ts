import { useCallback, useEffect, useMemo } from "react";
import type { WasmScene } from "lucida-core";
import { Axis } from "../axes.ts";
import { applyViewportCommand } from "../applyAndSend.ts";
import { invalidateSelection, requestRender } from "../invalidation.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { SceneStore } from "../sceneStore.ts";
import type { DatasetState } from "../types.ts";
import type { BridgeCallbacks } from "./useDatasetSettings.ts";
import { useSceneView } from "./useSceneView.ts";

interface Params {
  sceneStore: SceneStore;
  wasmSceneRef: React.RefObject<WasmScene | null>;
  datasetsRef: React.RefObject<Map<string, DatasetState>>;
  datasetsVersion: number;
  bridgeCallbacksRef: React.RefObject<BridgeCallbacks>;
  loopRef: React.RefObject<RenderLoop | null>;
}

/**
 * The selectors and view mode, read from the scene, and the controls that
 * change them. Each control writes the scene; the render after it reads the
 * new value back through the scene store.
 */
export function useDimensions({
  sceneStore,
  wasmSceneRef,
  datasetsRef,
  datasetsVersion,
  bridgeCallbacksRef,
  loopRef,
}: Params) {
  const { z, c, t, viewMode, cameraMode, multiChannel } = useSceneView(sceneStore);

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

  // Clamp z/c/t when the union shrinks, so the scene never selects a plane,
  // timepoint, or channel no open dataset has.
  useEffect(() => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    let clamped = false;
    if (scene.z() >= dimZ) {
      applyViewportCommand(scene, { type: "set_z", z: dimZ - 1 });
      clamped = true;
    }
    if (scene.c() >= dimC) {
      applyViewportCommand(scene, { type: "set_c", c: dimC - 1 });
      clamped = true;
    }
    if (scene.t() >= dimT) {
      applyViewportCommand(scene, { type: "set_t", t: dimT - 1 });
      clamped = true;
    }
    if (clamped) {
      requestRender(loopRef.current, "selector_clamp");
      bridgeCallbacksRef.current.emitPresence();
    }
    // A one-shot reaction to the union shrinking, not a continuous sync.
  }, [dimZ, dimC, dimT]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleViewModeToggle = useCallback(() => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    // Read at the press, not from the last render, so two presses before a
    // render still alternate.
    const next = scene.camera_mode() === "slice" ? "3d" : "2d";
    bridgeCallbacksRef.current.breakFollow();
    // The scene brings back the camera this mode last had, or fits a new one
    // to the data, on any canvas.
    applyViewportCommand(scene, { type: next === "3d" ? "set_mode_arcball" : "set_mode_slice" });
    // The mode switch remounts the viewer, whose new loop draws the new
    // camera; this tells the store as well.
    requestRender(loopRef.current, "view_mode");
    bridgeCallbacksRef.current.emitPresence();
  }, [wasmSceneRef, bridgeCallbacksRef, loopRef]);

  // The recorder hears the scrub here, at the control, not where the value
  // reaches the render loop. A saved-view apply and a followed peer move the
  // same selectors, and neither is an input.
  const handleZChange = useCallback((v: number) => {
    bridgeCallbacksRef.current.breakFollow();
    loopRef.current?.markInput("scrub");
    const scene = wasmSceneRef.current;
    if (scene) {
      applyViewportCommand(scene, { type: "set_z", z: v });
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [wasmSceneRef, bridgeCallbacksRef, loopRef]);

  const handleCChange = useCallback((v: number) => {
    bridgeCallbacksRef.current.breakFollow();
    loopRef.current?.markInput("scrub");
    const scene = wasmSceneRef.current;
    if (scene) {
      applyViewportCommand(scene, { type: "set_c", c: v });
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [wasmSceneRef, bridgeCallbacksRef, loopRef]);

  const handleTChange = useCallback((v: number) => {
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
    invalidateSelection(loopRef.current);
    bridgeCallbacksRef.current.emitPresence();
  }, [datasetsRef, wasmSceneRef, loopRef, bridgeCallbacksRef]);

  return useMemo(() => ({
    z, c, t,
    viewMode, cameraMode,
    multiChannel,
    dimZ, dimC, dimT,
    dimensionExtentsFor,
    labelNamesFor,
    soloChannel,
    handleViewModeToggle,
    handleZChange, handleCChange, handleTChange,
    handleSoloChannel, handleShowAllChannels, handleDatasetRegistered,
  }), [
    z, c, t, viewMode, cameraMode, multiChannel, dimZ, dimC, dimT,
    dimensionExtentsFor, labelNamesFor, soloChannel, handleViewModeToggle,
    handleZChange, handleCChange, handleTChange,
    handleSoloChannel, handleShowAllChannels, handleDatasetRegistered,
  ]);
}

function channelCountOf(ds: DatasetState): number {
  return ds.manifest.images[0]?.multiscale.levels[0]?.shape[Axis.C] ?? 1;
}
