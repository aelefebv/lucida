import { useCallback, useEffect, useState } from "react";
import type { WasmScene } from "lucida-core";
import { Axis } from "../axes.ts";
import type { ViewportCommand } from "../commands.ts";
import type { DatasetState, ViewMode } from "../types.ts";
import type { SceneMutationCallbacks } from "./useDatasetSettings.ts";

interface Params {
  wasmSceneRef: React.RefObject<WasmScene | null>;
  wasmScene: WasmScene | null;
  selectedDatasetId: string | null;
  datasetsRef: React.RefObject<Map<string, DatasetState>>;
  datasetsVersion: number;
  bridgeCallbacksRef: React.RefObject<SceneMutationCallbacks>;
}

export function useDimensions({
  wasmSceneRef,
  wasmScene,
  selectedDatasetId,
  datasetsRef,
  datasetsVersion,
  bridgeCallbacksRef,
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

  // Current label names (manifest `labels[]` order) for a dataset — the order
  // the per-label settings index into. Saved-view capture stamps these onto the
  // per-label display, and restore keys per-label settings by name+occurrence
  // against them, so a view whose label list changed still lands each setting on
  // the right current label. An unknown/unloaded dataset (or one with no labels)
  // returns `undefined`, which leaves the per-label handling positional.
  const labelNamesFor = useCallback(
    (datasetId: string): string[] | undefined => {
      const ds = datasetsRef.current.get(datasetId);
      const labels = ds?.manifest.labels;
      if (!labels || labels.length === 0) return undefined;
      return labels.map((l) => l.name);
    },
    [datasetsRef],
  );

  // Clamp slider values when union dimensions shrink, and sync to WASM scene.
  // The clamp is a synchronization with external state (manifest dim union),
  // not a derivation — z/c/t are user-controlled but must follow the open
  // dataset's bounds. setState here IS the intended effect.
  useEffect(() => {
    const scene = wasmSceneRef.current;
    const commands: ViewportCommand[] = [];
    let nextZ: number | null = null;
    let nextC: number | null = null;
    let nextT: number | null = null;
    if (z >= dimZ) {
      nextZ = dimZ - 1;
      commands.push({ type: "set_z", z: nextZ });
    }
    if (c >= dimC) {
      nextC = dimC - 1;
      commands.push({ type: "set_c", c: nextC });
    }
    if (t >= dimT) {
      nextT = dimT - 1;
      commands.push({ type: "set_t", t: nextT });
    }
    if (commands.length > 0) {
      // With no scene there is nothing to synchronize yet, but React still must
      // respect the manifest bounds. Otherwise update the mirror only after the
      // canonical scene batch commits.
      const applied = !scene || bridgeCallbacksRef.current.mutateViewport(commands, {
          source: "dimension_clamp",
          history: { skip: true },
        });
      if (applied) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (nextZ !== null) setZ(nextZ);
        if (nextC !== null) setC(nextC);
        if (nextT !== null) setT(nextT);
      }
    }
    // Deliberately omit z/c/t/wasmSceneRef/bridgeCallbacksRef: the clamp
    // is a one-shot reaction to dim shrinkage, not a continuous sync.
  }, [dimZ, dimC, dimT]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleViewModeToggle = useCallback(() => {
    const next = viewMode === "2d" ? "3d" : "2d";
    if (!wasmScene) {
      setViewMode(next);
      return;
    }
    const commands: ViewportCommand[] = [
      { type: next === "3d" ? "set_mode_arcball" : "set_mode_slice" },
    ];
    if (next === "2d" && selectedDatasetId) {
      const dsManifest = datasetsRef.current.get(selectedDatasetId)?.manifest;
      if (dsManifest) {
        const shapeX = dsManifest.images[0].multiscale.levels[0].shape[Axis.X];
        const shapeY = dsManifest.images[0].multiscale.levels[0].shape[Axis.Y];
        commands.push({ type: "set_center", x: shapeX / 2, y: shapeY / 2 });
      }
    }
    if (bridgeCallbacksRef.current.mutateViewport(commands, { source: "view_mode_toggle" })) {
      setViewMode(next);
    }
  }, [viewMode, wasmScene, selectedDatasetId, datasetsRef, bridgeCallbacksRef]);

  const handleZChange = useCallback((v: number) => {
    const scene = wasmSceneRef.current;
    if (!scene) {
      setZ(v);
      return;
    }
    if (bridgeCallbacksRef.current.mutateViewport(
        { type: "set_z", z: v },
        {
          source: "dimension_z",
          history: { label: "Z position", coalesceKey: "dimension_z", coalesceWindowMs: 250 },
        },
      )) {
      setZ(v);
    }
  }, [wasmSceneRef, bridgeCallbacksRef]);

  const handleCChange = useCallback((v: number) => {
    const scene = wasmSceneRef.current;
    if (!scene) {
      setC(v);
      return;
    }
    if (bridgeCallbacksRef.current.mutateViewport(
        { type: "set_c", c: v },
        {
          source: "dimension_c",
          history: { label: "channel", coalesceKey: "dimension_c", coalesceWindowMs: 250 },
        },
      )) {
      setC(v);
    }
  }, [wasmSceneRef, bridgeCallbacksRef]);

  const handleTChange = useCallback((v: number) => {
    const scene = wasmSceneRef.current;
    if (!scene) {
      setT(v);
      return;
    }
    if (bridgeCallbacksRef.current.mutateViewport(
        { type: "set_t", t: v },
        {
          source: "dimension_t",
          history: { label: "timepoint", coalesceKey: "dimension_t", coalesceWindowMs: 250 },
        },
      )) {
      setT(v);
    }
  }, [wasmSceneRef, bridgeCallbacksRef]);

  const handleMultiChannelToggle = useCallback(() => {
    const next = !multiChannel;
    const scene = wasmSceneRef.current;
    if (!scene) {
      setMultiChannel(next);
      return;
    }
    if (bridgeCallbacksRef.current.mutateViewport(
        { type: "set_multi_channel", enabled: next },
        { source: "multi_channel_toggle", invalidation: "display" },
      )) {
      setMultiChannel(next);
    }
  }, [multiChannel, wasmSceneRef, bridgeCallbacksRef]);

  return {
    z, c, t, setZ, setC, setT,
    viewMode, setViewMode,
    multiChannel, setMultiChannel,
    dimZ, dimC, dimT,
    dimensionExtentsFor,
    labelNamesFor,
    handleViewModeToggle,
    handleZChange, handleCChange, handleTChange, handleMultiChannelToggle,
  };
}
