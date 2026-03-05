/** 2D slice viewer — WebGPU-accelerated tile rendering with pan/zoom. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import type { VolumeData } from "../zarr/volumeAssembler.ts";
import type { DatasetInfo } from "../zarr/metadata.ts";
import { ChunkStore, useChunkStore, chunkKeyFromCoord } from "../zarr/chunkStore.ts";
import type { ChunkCoord } from "../zarr/chunkStore.ts";
import { initGPU, createSliceTexture, writeSliceRegion } from "../renderer/gpuContext.ts";
import { SliceRenderer } from "../renderer/sliceRenderer.ts";

interface Props {
  volume: VolumeData;
  z: number;
  t: number;
  c: number;
  scene: WasmScene;
  store: ChunkStore;
  datasetInfo: DatasetInfo;
}

export function SliceViewer({ volume, z, t, c, scene, store, datasetInfo }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // GPU state refs
  const gpuRef = useRef<{
    device: GPUDevice;
    context: GPUCanvasContext;
    renderer: SliceRenderer;
  } | null>(null);

  // Track current tile texture state for invalidation
  const tileStateRef = useRef<{
    texture: GPUTexture;
    level: number;
    z: number;
    t: number;
    c: number;
  } | null>(null);

  // Subscribe to store updates — triggers re-render when chunks arrive
  const storeVersion = useChunkStore(store);

  // Rust camera is the single source of truth for pan/zoom.
  const [cameraVersion, setCameraVersion] = useState(0);
  const bumpCamera = useCallback(() => setCameraVersion(v => v + 1), []);
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // Reset pan/zoom when the dataset dimensions change
  const prevDims = useRef({ w: volume.width, h: volume.height, d: volume.depth });
  useEffect(() => {
    const { width, height, depth } = volume;
    const prev = prevDims.current;
    if (width !== prev.w || height !== prev.h || depth !== prev.d) {
      prevDims.current = { w: width, h: height, d: depth };
      const fullResWidth = datasetInfo.levels[0].shape[4];
      const fullResHeight = datasetInfo.levels[0].shape[3];
      scene.set_center(fullResWidth / 2, fullResHeight / 2);
      scene.set_zoom(1.0);
      bumpCamera();
      tileStateRef.current = null;
    }
  }, [volume, scene, datasetInfo, bumpCamera]);

  // Initialize WebGPU
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let destroyed = false;

    initGPU(canvas).then(({ device, context, format }) => {
      if (destroyed) return;
      const renderer = new SliceRenderer(device, context, format);
      gpuRef.current = { device, context, renderer };
      // Trigger initial render
      bumpCamera();
    }).catch(err => {
      console.error("WebGPU init failed:", err);
    });

    return () => {
      destroyed = true;
      if (tileStateRef.current) {
        tileStateRef.current.texture.destroy();
        tileStateRef.current = null;
      }
      gpuRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Upload fallback (coarsest-level) texture
  useEffect(() => {
    const gpu = gpuRef.current;
    if (!gpu) return;

    const { width, height, depth, data } = volume;
    const clampedZ = Math.max(0, Math.min(z, depth - 1));
    const sliceSize = width * height;
    const offset = clampedZ * sliceSize;
    const slice = data.subarray(offset, offset + sliceSize);

    // Sample intensity range
    let min = 65535, max = 0;
    const step = Math.max(1, Math.floor(sliceSize / 100000));
    for (let i = 0; i < sliceSize; i += step) {
      const v = slice[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }

    const texture = createSliceTexture(gpu.device, width, height, slice);
    gpu.renderer.setFallback(texture);
    gpu.renderer.setIntensityRange(min, max);
  }, [volume, z]);

  // Request chunks when view state changes
  useEffect(() => {
    let plan: { needed: ChunkCoord[] };
    try {
      plan = JSON.parse(scene.chunk_plan());
    } catch {
      return;
    }
    if (plan.needed.length > 0) {
      store.ensureFetched(plan.needed);
    }
  }, [scene, store, z, t, c, cameraVersion]);

  // Upload tiles and render
  useEffect(() => {
    const canvas = canvasRef.current;
    const gpu = gpuRef.current;
    if (!canvas || !gpu) return;

    // Get current chunk plan
    let plan: { needed: ChunkCoord[] };
    try {
      plan = JSON.parse(scene.chunk_plan());
    } catch {
      return;
    }

    const needed = plan.needed;
    const level = needed[0]?.level;

    if (level !== undefined) {
      const levelMeta = datasetInfo.levels[level];
      if (levelMeta) {
        const [, , , levelHeight, levelWidth] = levelMeta.shape;
        const [, , chunkZ, chunkY, chunkX] = levelMeta.chunkShape;

        // Invalidate tile texture if view params changed
        const ts = tileStateRef.current;
        if (!ts || ts.level !== level || ts.z !== z || ts.t !== t || ts.c !== c) {
          if (ts) ts.texture.destroy();
          const texture = createSliceTexture(gpu.device, levelWidth, levelHeight, null);
          tileStateRef.current = { texture, level, z, t, c };
          gpu.renderer.setTileTexture(texture);
        }

        // Map full-res Z index to this level's Z coordinate space
        const fullResDepth = datasetInfo.levels[0].shape[2];
        const levelDepth = levelMeta.shape[2];
        const levelZ = Math.min(
          Math.floor((z / Math.max(fullResDepth - 1, 1)) * Math.max(levelDepth - 1, 1)),
          levelDepth - 1,
        );
        const targetChunkZ = Math.floor(levelZ / chunkZ);
        const localZ = levelZ - targetChunkZ * chunkZ;

        // Collect available chunks
        const availableChunks: { coord: ChunkCoord; data: Uint16Array }[] = [];
        for (const coord of needed) {
          if (coord.level !== level) continue;
          const buf = store.get(chunkKeyFromCoord(coord));
          if (buf) {
            availableChunks.push({ coord, data: new Uint16Array(buf) });
          }
        }

        if (availableChunks.length > 0) {
          // Auto-detect intensity range
          let min = 65535, max = 0;
          for (const { data } of availableChunks) {
            const sampleStep = Math.max(1, Math.floor(data.length / 10000));
            for (let i = 0; i < data.length; i += sampleStep) {
              const v = data[i];
              if (v < min) min = v;
              if (v > max) max = v;
            }
          }
          gpu.renderer.setIntensityRange(min, max);

          // Upload each chunk tile to the tile texture
          const tileTexture = tileStateRef.current!.texture;
          for (const { coord, data } of availableChunks) {
            if (coord.z !== targetChunkZ) continue;

            const xOff = coord.x * chunkX;
            const yOff = coord.y * chunkY;
            const tileW = Math.min(chunkX, levelWidth - xOff);
            const tileH = Math.min(chunkY, levelHeight - yOff);

            // Extract the z-slice from the chunk and upload
            const sliceOffset = localZ * chunkY * chunkX;
            const sliceData = data.subarray(sliceOffset, sliceOffset + chunkY * chunkX);
            writeSliceRegion(gpu.device, tileTexture, sliceData, chunkX, xOff, yOff, tileW, tileH);
          }
        }
      }
    }

    // Render
    const canvasW = canvas.clientWidth;
    const canvasH = canvas.clientHeight;
    canvas.width = canvasW;
    canvas.height = canvasH;
    scene.set_viewport(canvasW, canvasH);

    const fullResWidth = datasetInfo.levels[0].shape[4];
    const fullResHeight = datasetInfo.levels[0].shape[3];

    const currentZoom = scene.zoom();
    const centerArr = scene.center();
    const cx = centerArr[0];
    const cy = centerArr[1];

    gpu.renderer.render(currentZoom, cx, cy, canvasW, canvasH, fullResWidth, fullResHeight);
  }, [volume, z, t, c, cameraVersion, storeVersion, datasetInfo, scene, store]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      setDragging(true);
      lastPos.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!dragging) return;
      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      lastPos.current = { x: e.clientX, y: e.clientY };
      scene.pan(-dx, -dy);
      bumpCamera();
    },
    [dragging, scene, bumpCamera],
  );

  const onPointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;

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
      scene.zoom_by(factor);
      const newZoom = scene.zoom();

      scene.set_center(
        worldX - (cursorX - canvasW / 2) / newZoom,
        worldY - (cursorY - canvasH / 2) / newZoom,
      );
      bumpCamera();
    },
    [scene, bumpCamera],
  );

  // Attach wheel handler with { passive: false } to allow preventDefault
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        width: "100%",
        height: 600,
        maxWidth: 800,
        imageRendering: "pixelated",
        borderRadius: 8,
        cursor: dragging ? "grabbing" : "grab",
        backgroundColor: "black",
      }}
    />
  );
}
