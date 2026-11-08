import { useCallback, useEffect, useMemo } from "react";
import type { WasmScene } from "lucida-core";
import { Axis } from "../axes.ts";
import { applyViewportCommand } from "../applyAndSend.ts";
import { requestRender } from "../invalidation.ts";
import type { RenderLoop } from "../renderLoop.ts";
import type { SceneStore } from "../sceneStore.ts";
import { getViewportClass } from "../theme/viewport.ts";
import type { DatasetState } from "../types.ts";
import type { BridgeCallbacks } from "./useDatasetSettings.ts";
import { useSceneView } from "./useSceneView.ts";

interface Params {
  sceneStore: SceneStore;
  wasmSceneRef: React.RefObject<WasmScene | null>;
  selectedDatasetId: string | null;
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
  selectedDatasetId,
  datasetsRef,
  datasetsVersion,
  bridgeCallbacksRef,
  loopRef,
}: Params) {
  const { z, t, viewMode, cameraMode, layers } = useSceneView(sceneStore);

  // Slider ranges are the union across all datasets, and the scene clamps
  // them into each smaller layer. `datasetsVersion` re-renders on every Map
  // mutation, so reading the ref here is current.
  let dimZ = 1, dimT = 1;
  void datasetsVersion;
  // eslint-disable-next-line react-hooks/refs
  for (const ds of datasetsRef.current.values()) {
    const shape = ds.manifest.images[0].multiscale.levels[0].shape; // [T, C, Z, Y, X]
    dimZ = Math.max(dimZ, shape[Axis.Z]);
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

  // Clamp z/t when the union shrinks, so the scene never selects a plane or
  // timepoint no open dataset has.
  useEffect(() => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    let clamped = false;
    if (scene.z() >= dimZ) {
      applyViewportCommand(scene, { type: "set_z", z: dimZ - 1 });
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
  }, [dimZ, dimT]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleViewModeToggle = useCallback(() => {
    const scene = wasmSceneRef.current;
    if (!scene) return;
    // Read at the press, not from the last render, so two presses before a
    // render still alternate.
    const next = scene.camera_mode() === "slice" ? "3d" : "2d";
    bridgeCallbacksRef.current.breakFollow();
    applyViewportCommand(scene, { type: next === "3d" ? "set_mode_arcball" : "set_mode_slice" });
    if (next === "2d" && selectedDatasetId) {
      const dsManifest = datasetsRef.current.get(selectedDatasetId)?.manifest;
      if (dsManifest) {
        const shapeX = dsManifest.images[0].multiscale.levels[0].shape[Axis.X];
        const shapeY = dsManifest.images[0].multiscale.levels[0].shape[Axis.Y];
        applyViewportCommand(scene, { type: "set_center", x: shapeX / 2, y: shapeY / 2 });
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
        scene.fit_camera_to_dataset_bounds(fitId);
      } catch {
        // A dataset with nothing loaded yet has no bounds; the fixed camera stays.
      }
    }
    // The mode switch remounts the viewer, whose new loop draws the new
    // camera; this tells the store about the fit as well.
    requestRender(loopRef.current, "view_mode");
    bridgeCallbacksRef.current.emitPresence();
  }, [wasmSceneRef, selectedDatasetId, datasetsRef, bridgeCallbacksRef, loopRef]);

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


  const handleTChange = useCallback((v: number) => {
    bridgeCallbacksRef.current.breakFollow();
    loopRef.current?.markInput("scrub");
    const scene = wasmSceneRef.current;
    if (scene) {
      applyViewportCommand(scene, { type: "set_t", t: v });
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [wasmSceneRef, bridgeCallbacksRef, loopRef]);

  return useMemo(() => ({
    z, t,
    viewMode, cameraMode,
    layers,
    dimZ, dimT,
    dimensionExtentsFor,
    labelNamesFor,
    handleViewModeToggle,
    handleZChange, handleTChange,
  }), [
    z, t, viewMode, cameraMode, layers, dimZ, dimT,
    dimensionExtentsFor, labelNamesFor, handleViewModeToggle,
    handleZChange, handleTChange,
  ]);
}
