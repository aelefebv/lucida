import { useCallback, useEffect, useState } from "react";
import type { WasmScene } from "lucida-core";
import { Axis } from "../axes.ts";
import { applyViewportCommand } from "../applyAndSend.ts";
import { invalidateDisplaySettings } from "../invalidation.ts";
import type { RenderLoop } from "../renderLoop.ts";
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

  // Union dimension extents across ALL datasets for slider ranges.
  // datasetsRef holds the live Map; datasetsVersion is the React-side
  // bumper that triggers a re-render whenever the Map mutates, so reading
  // .current here always sees the latest set.
  let dimZ = 1, dimC = 1, dimT = 1;
  void datasetsVersion;
  // eslint-disable-next-line react-hooks/refs
  for (const ds of datasetsRef.current.values()) {
    const shape = ds.manifest.images[0].multiscale.levels[0].shape; // [T, C, Z, Y, X]
    dimZ = Math.max(dimZ, shape[Axis.Z]);
    dimC = Math.max(dimC, shape[Axis.C]);
    dimT = Math.max(dimT, shape[Axis.T]);
  }

  // Per-dataset T/C/Z extents (counts) for saved-view clamping. The applier
  // can read Z from the scene's volume shape but NOT T/C, so it asks for
  // these. We answer from the loaded manifest (shape is [T, C, Z, Y, X]);
  // an unknown/unloaded dataset returns `{}`, leaving that axis unclamped.
  const dimensionExtentsFor = useCallback(
    (datasetId: string): { z?: number; t?: number; c?: number } => {
      const ds = datasetsRef.current.get(datasetId);
      const shape = ds?.manifest.images[0]?.multiscale.levels[0]?.shape;
      if (!shape) return {};
      return { z: shape[Axis.Z], t: shape[Axis.T], c: shape[Axis.C] };
    },
    [datasetsRef],
  );

  // Clamp slider values when union dimensions shrink, and sync to WASM scene.
  // The clamp is a synchronization with external state (manifest dim union),
  // not a derivation — z/c/t are user-controlled but must follow the open
  // dataset's bounds. setState here IS the intended effect.
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
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [viewMode, wasmScene, selectedDatasetId, datasetsRef, bridgeCallbacksRef]);

  const handleZChange = useCallback((v: number) => {
    setZ(v);
    bridgeCallbacksRef.current.breakFollow();
    const scene = wasmSceneRef.current;
    if (scene) {
      applyViewportCommand(scene, { type: "set_z", z: v });
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [wasmSceneRef, bridgeCallbacksRef]);

  const handleCChange = useCallback((v: number) => {
    setC(v);
    bridgeCallbacksRef.current.breakFollow();
    const scene = wasmSceneRef.current;
    if (scene) {
      applyViewportCommand(scene, { type: "set_c", c: v });
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [wasmSceneRef, bridgeCallbacksRef]);

  const handleTChange = useCallback((v: number) => {
    setT(v);
    bridgeCallbacksRef.current.breakFollow();
    const scene = wasmSceneRef.current;
    if (scene) {
      applyViewportCommand(scene, { type: "set_t", t: v });
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [wasmSceneRef, bridgeCallbacksRef]);

  const handleMultiChannelToggle = useCallback(() => {
    const next = !multiChannel;
    setMultiChannel(next);
    bridgeCallbacksRef.current.breakFollow();
    const scene = wasmSceneRef.current;
    if (scene) {
      applyViewportCommand(scene, { type: "set_multi_channel", enabled: next });
      invalidateDisplaySettings(loopRef.current, "multi_channel_toggle");
      bridgeCallbacksRef.current.emitPresence();
    }
  }, [multiChannel, wasmSceneRef, bridgeCallbacksRef, loopRef]);

  return {
    z, c, t, setZ, setC, setT,
    viewMode, setViewMode,
    multiChannel, setMultiChannel,
    dimZ, dimC, dimT,
    dimensionExtentsFor,
    handleViewModeToggle,
    handleZChange, handleCChange, handleTChange, handleMultiChannelToggle,
  };
}
