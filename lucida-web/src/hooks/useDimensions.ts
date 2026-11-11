import { useCallback, useEffect, useMemo } from "react";
import type { WasmScene } from "lucida-core";
import { Axis, resolveIndex, type IndexChange } from "../axes.ts";
import { cutAxis, type SlicePlane, type SpatialAxis } from "../renderer/slicePlane.ts";
import { applyViewportCommand } from "../applyAndSend.ts";
import { requestRender } from "../invalidation.ts";
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
  const { z, t, viewMode, cameraMode, layers, slicePlane, cutIndex, cutPlace } = useSceneView(sceneStore);

  // The T slider is the union across all datasets, and the scene clamps it
  // into each shorter layer. `datasetsVersion` re-renders on every Map
  // mutation, so reading the ref here is current.
  let dimT = 1;
  void datasetsVersion;
  // eslint-disable-next-line react-hooks/refs
  for (const ds of datasetsRef.current.values()) {
    const shape = ds.manifest.images[0].multiscale.levels[0].shape; // [T, C, Z, Y, X]
    dimT = Math.max(dimT, shape[Axis.T]);
  }
  // A spatial position is a place in the scene frame, on a grid the scene
  // lays over what is visible at the finest spacing among the layers.
  // eslint-disable-next-line react-hooks/refs
  const dimZ = wasmSceneRef.current?.grid_count("z") ?? 1;
  // eslint-disable-next-line react-hooks/refs
  const dimCut = wasmSceneRef.current?.cut_extent() ?? 1;

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

  // Clamp t when the union shrinks, so the scene never selects a timepoint no
  // open dataset has. A spatial place stays where it is: a layer it misses
  // says it is outside the cut.
  useEffect(() => {
    const scene = wasmSceneRef.current;
    if (!scene || scene.t() < dimT) return;
    applyViewportCommand(scene, { type: "set_t", t: dimT - 1 });
    requestRender(loopRef.current, "selector_clamp");
    bridgeCallbacksRef.current.emitPresence();
    // A one-shot reaction to the union shrinking, not a continuous sync.
  }, [dimT]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // same selectors, and neither is an input. A step reads the scene at the
  // press, not the last render, so presses before a render each move. The
  // slider moves along the slice plane's cut: Z for an XY view, Y or X for a
  // side view.
  const handleAxisChange = useCallback((axis: SpatialAxis, index: number) => {
    bridgeCallbacksRef.current.breakFollow();
    loopRef.current?.markInput("scrub");
    const scene = wasmSceneRef.current;
    if (scene) {
      applyViewportCommand(scene, axis === "z"
        ? { type: "set_z", z: index }
        : axis === "y" ? { type: "set_y", y: index } : { type: "set_x", x: index });
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [wasmSceneRef, bridgeCallbacksRef, loopRef]);

  const handleCutChange = useCallback((v: IndexChange) => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    const axis = cutAxis(scene.slice_plane(scene.active_view()) as SlicePlane);
    handleAxisChange(axis, resolveIndex(v, scene.cut_index(scene.active_view())));
  }, [wasmSceneRef, handleAxisChange]);

  // A plane is another camera, as a mode is, so it fits the data again.
  const handleSlicePlaneChange = useCallback((plane: SlicePlane) => {
    const scene = wasmSceneRef.current;
    if (!scene || scene.slice_plane(scene.active_view()) === plane) return;
    bridgeCallbacksRef.current.breakFollow();
    loopRef.current?.markInput("plane");
    applyViewportCommand(scene, { type: "set_slice_plane", plane });
    requestRender(loopRef.current, "view_mode");
    bridgeCallbacksRef.current.emitPresence();
  }, [wasmSceneRef, bridgeCallbacksRef, loopRef]);

  const handleTChange = useCallback((v: IndexChange) => {
    bridgeCallbacksRef.current.breakFollow();
    loopRef.current?.markInput("scrub");
    const scene = wasmSceneRef.current;
    if (scene) {
      applyViewportCommand(scene, { type: "set_t", t: resolveIndex(v, scene.t()) });
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [wasmSceneRef, bridgeCallbacksRef, loopRef]);

  return useMemo(() => ({
    z, t,
    viewMode, cameraMode,
    layers,
    dimZ, dimT,
    slicePlane, cutIndex, cutPlace, dimCut,
    dimensionExtentsFor,
    labelNamesFor,
    handleViewModeToggle,
    handleTChange,
    handleCutChange, handleAxisChange, handleSlicePlaneChange,
  }), [
    z, t, viewMode, cameraMode, layers, dimZ, dimT,
    slicePlane, cutIndex, cutPlace, dimCut,
    dimensionExtentsFor, labelNamesFor, handleViewModeToggle,
    handleTChange, handleCutChange, handleAxisChange, handleSlicePlaneChange,
  ]);
}
