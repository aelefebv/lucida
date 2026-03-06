/** 2D slice viewer — delegates WebGPU rendering to a worker via RenderClient. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import type { VolumeData } from "../zarr/volumeAssembler.ts";
import type { DatasetInfo } from "../zarr/metadata.ts";
import { ChunkStore, useChunkStore } from "../zarr/chunkStore.ts";
import type { ChunkCoord } from "../zarr/chunkStore.ts";
import { RenderClient } from "../renderer/renderClient.ts";
import { evaluateChunkPlan } from "../zarr/chunkPlan.ts";
import { applyAndSend } from "../applyAndSend.ts";

interface Props {
  volume: VolumeData;
  z: number;
  t: number;
  c: number;
  scene: WasmScene;
  store: ChunkStore;
  datasetInfo: DatasetInfo;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  remoteCameraVersion: number;
  sendCommand: (json: string) => void;
}

export function SliceViewer({ volume, z, t, c, scene, store, datasetInfo, client, canvas, remoteCameraVersion, sendCommand }: Props) {
  const storeVersion = useChunkStore(store);

  const [cameraVersion, setCameraVersion] = useState(0);
  const bumpCamera = useCallback(() => setCameraVersion(v => v + 1), []);
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const planRef = useRef<{ needed: ChunkCoord[] } | null>(null);
  const uploadedRef = useRef<Set<string>>(new Set());
  const sliceLodRef = useRef<{ level: number; z: number; t: number; c: number } | null>(null);

  // Reset pan/zoom when the dataset dimensions change
  const prevDims = useRef({ w: volume.width, h: volume.height, d: volume.depth });
  useEffect(() => {
    const { width, height, depth } = volume;
    const prev = prevDims.current;
    if (width !== prev.w || height !== prev.h || depth !== prev.d) {
      prevDims.current = { w: width, h: height, d: depth };
      const fullResWidth = datasetInfo.levels[0].shape[4];
      const fullResHeight = datasetInfo.levels[0].shape[3];
      applyAndSend(scene, { type: "set_center", x: fullResWidth / 2, y: fullResHeight / 2 }, sendCommand);
      applyAndSend(scene, { type: "set_zoom", value: 1.0 }, sendCommand);
      bumpCamera();
    }
  }, [volume, scene, datasetInfo, bumpCamera, sendCommand]);

  // Set mode on mount
  useEffect(() => {
    client.setModeSlice();
  }, [client]);

  // Upload fallback (coarsest-level) texture
  useEffect(() => {
    const { width, height, depth, data } = volume;
    const clampedZ = Math.max(0, Math.min(z, depth - 1));
    const sliceSize = width * height;
    const offset = clampedZ * sliceSize;
    const slice = data.subarray(offset, offset + sliceSize);
    client.sliceSetFallback(slice, width, height);
  }, [volume, z, client]);

  // Request chunks when view state changes
  useEffect(() => {
    scene.set_z(z);
    scene.set_t(t);
    scene.set_c(c);
    const plan = evaluateChunkPlan(scene);
    planRef.current = plan;
    if (plan && plan.needed.length > 0) {
      store.ensureFetched(plan.needed);
    }
  }, [scene, store, z, t, c, cameraVersion, remoteCameraVersion]);

  // Upload tiles and render
  useEffect(() => {
    const plan = planRef.current;
    if (!plan) return;

    const needed = plan.needed;
    const level = needed[0]?.level;

    if (level !== undefined) {
      const levelMeta = datasetInfo.levels[level];
      if (levelMeta) {
        const [, , , levelHeight, levelWidth] = levelMeta.shape;
        const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;
        const fullResDepth = datasetInfo.levels[0].shape[2];
        const levelDepth = levelMeta.shape[2];

        // Reset uploaded set when view params change
        const lod = sliceLodRef.current;
        if (!lod || lod.level !== level || lod.z !== z || lod.t !== t || lod.c !== c) {
          uploadedRef.current = new Set();
          sliceLodRef.current = { level, z, t, c };
        }

        // Collect only newly-available chunks
        const availableChunks: { data: Uint16Array; x: number; y: number; z: number; key: string }[] = [];
        for (const coord of needed) {
          if (coord.level !== level) continue;
          if (uploadedRef.current.has(coord.key)) continue;
          const buf = store.get(coord.key);
          if (buf) {
            availableChunks.push({ data: new Uint16Array(buf), x: coord.x, y: coord.y, z: coord.z, key: coord.key });
            uploadedRef.current.add(coord.key);
          }
        }

        if (availableChunks.length > 0) {
          client.sliceUploadTiles(
            availableChunks,
            level, z, t, c,
            levelWidth, levelHeight,
            chunkX, chunkY, chunkZ,
            fullResDepth, levelDepth, z,
          );
        }
      }
    }

    // Render
    const canvasW = canvas.clientWidth;
    const canvasH = canvas.clientHeight;
    scene.set_viewport(canvasW, canvasH);

    const fullResWidth = datasetInfo.levels[0].shape[4];
    const fullResHeight = datasetInfo.levels[0].shape[3];

    const currentZoom = scene.zoom();
    const centerArr = scene.center();
    const cx = centerArr[0];
    const cy = centerArr[1];

    client.resize(canvasW, canvasH);
    client.sliceRender(currentZoom, cx, cy, canvasW, canvasH, fullResWidth, fullResHeight);
  }, [volume, z, t, c, cameraVersion, remoteCameraVersion, storeVersion, datasetInfo, scene, store, client, canvas]);

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      setDragging(true);
      lastPos.current = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    },
    [canvas],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      lastPos.current = { x: e.clientX, y: e.clientY };
      const pdx = -dx;
      const pdy = -dy;
      applyAndSend(scene, { type: "pan", dx: pdx, dy: pdy }, sendCommand);
      bumpCamera();
    },
    [dragging, scene, bumpCamera, sendCommand],
  );

  const onPointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();

      const rect = canvas.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const canvasW = canvas.clientWidth;
      const canvasH = canvas.clientHeight;

      const oldZoom = scene.zoom();
      const centerArr = scene.center();
      const worldX = (cursorX - canvasW / 2) / oldZoom + centerArr[0];
      const worldY = (cursorY - canvasH / 2) / oldZoom + centerArr[1];

      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      applyAndSend(scene, { type: "zoom_by", factor }, sendCommand);
      const newZoom = scene.zoom();

      const newCx = worldX - (cursorX - canvasW / 2) / newZoom;
      const newCy = worldY - (cursorY - canvasH / 2) / newZoom;
      applyAndSend(scene, { type: "set_center", x: newCx, y: newCy }, sendCommand);
      bumpCamera();
    },
    [scene, bumpCamera, canvas, sendCommand],
  );

  // Attach event handlers to the shared canvas
  useEffect(() => {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.style.cursor = dragging ? "grabbing" : "grab";
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [canvas, onPointerDown, onPointerMove, onPointerUp, onWheel, dragging]);

  return null;
}
