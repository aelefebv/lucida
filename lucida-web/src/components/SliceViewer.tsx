/** 2D slice viewer — pull-based tile rendering with pan/zoom. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { WasmScene } from "lucida-core";
import type { VolumeData } from "../zarr/volumeAssembler.ts";
import type { DatasetInfo } from "../zarr/metadata.ts";
import { ChunkStore, useChunkStore, chunkKeyFromCoord } from "../zarr/chunkStore.ts";
import type { ChunkCoord } from "../zarr/chunkStore.ts";

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

  // Fallback offscreen (coarsest-level full render)
  const fallbackRef = useRef<OffscreenCanvas | null>(null);
  // Tile canvas for the current LOD level
  const tileStateRef = useRef<{
    canvas: OffscreenCanvas;
    level: number;
    z: number;
    t: number;
    c: number;
  } | null>(null);

  // Subscribe to store updates — triggers re-render when chunks arrive
  const storeVersion = useChunkStore(store);

  // Use WasmScene as source of truth for zoom/offset
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [zoom, setZoom] = useState(1.0);
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // Reset pan/zoom when the dataset dimensions change
  const prevDims = useRef({ w: volume.width, h: volume.height, d: volume.depth });
  useEffect(() => {
    const { width, height, depth } = volume;
    const prev = prevDims.current;
    if (width !== prev.w || height !== prev.h || depth !== prev.d) {
      prevDims.current = { w: width, h: height, d: depth };
      setOffsetX(0);
      setOffsetY(0);
      setZoom(1.0);
      tileStateRef.current = null;
    }
  }, [volume]);

  // Render the initial coarsest-level data to the fallback canvas
  useEffect(() => {
    const { width, height, depth, data } = volume;
    const clampedZ = Math.max(0, Math.min(z, depth - 1));
    const sliceSize = width * height;
    const offset = clampedZ * sliceSize;
    const slice = data.subarray(offset, offset + sliceSize);

    let min = 65535, max = 0;
    const step = Math.max(1, Math.floor(sliceSize / 100000));
    for (let i = 0; i < sliceSize; i += step) {
      const v = slice[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min || 1;

    const offscreen = new OffscreenCanvas(width, height);
    const ctx = offscreen.getContext("2d")!;
    const imageData = ctx.createImageData(width, height);
    const pixels = imageData.data;

    for (let i = 0; i < sliceSize; i++) {
      const normalized = ((slice[i] - min) / range) * 255;
      const byte = normalized < 0 ? 0 : normalized > 255 ? 255 : normalized;
      const p = i * 4;
      pixels[p] = byte;
      pixels[p + 1] = byte;
      pixels[p + 2] = byte;
      pixels[p + 3] = 255;
    }

    ctx.putImageData(imageData, 0, 0);
    fallbackRef.current = offscreen;
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
  }, [scene, store, z, t, c, zoom, offsetX, offsetY]);

  // Paint tiles from store + composite onto visible canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

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

        // Invalidate tile canvas if view params changed
        const ts = tileStateRef.current;
        if (!ts || ts.level !== level || ts.z !== z || ts.t !== t || ts.c !== c) {
          tileStateRef.current = {
            canvas: new OffscreenCanvas(levelWidth, levelHeight),
            level,
            z,
            t,
            c,
          };
        }

        const tileCanvas = tileStateRef.current!.canvas;
        const ctx = tileCanvas.getContext("2d")!;

        // Clear and repaint all available tiles
        ctx.clearRect(0, 0, tileCanvas.width, tileCanvas.height);

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
          const range = max - min || 1;

          // Paint each chunk tile
          for (const { coord, data } of availableChunks) {
            if (coord.z !== targetChunkZ) continue;

            const xOff = coord.x * chunkX;
            const yOff = coord.y * chunkY;
            const tileW = Math.min(chunkX, levelWidth - xOff);
            const tileH = Math.min(chunkY, levelHeight - yOff);

            const imageData = ctx.createImageData(tileW, tileH);
            const pixels = imageData.data;

            for (let dy = 0; dy < tileH; dy++) {
              for (let dx = 0; dx < tileW; dx++) {
                const srcIdx = (localZ * chunkY + dy) * chunkX + dx;
                const normalized = ((data[srcIdx] - min) / range) * 255;
                const byte = normalized < 0 ? 0 : normalized > 255 ? 255 : normalized;
                const p = (dy * tileW + dx) * 4;
                pixels[p] = byte;
                pixels[p + 1] = byte;
                pixels[p + 2] = byte;
                pixels[p + 3] = 255;
              }
            }

            ctx.putImageData(imageData, xOff, yOff);
          }
        }
      }
    }

    // Composite onto visible canvas
    const source = tileStateRef.current?.canvas ?? fallbackRef.current;
    if (!source) return;

    const canvasW = canvas.clientWidth;
    const canvasH = canvas.clientHeight;
    canvas.width = canvasW;
    canvas.height = canvasH;
    scene.set_viewport(canvasW, canvasH);

    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvasW, canvasH);

    const fullResWidth = datasetInfo.levels[0].shape[4];
    const fullResHeight = datasetInfo.levels[0].shape[3];
    const dataW = fullResWidth;
    const dataH = fullResHeight;

    const dx = canvasW / 2 - (dataW / 2 - offsetX) * zoom;
    const dy = canvasH / 2 - (dataH / 2 - offsetY) * zoom;
    const dw = dataW * zoom;
    const dh = dataH * zoom;

    // Draw fallback first as a backdrop if we have a separate tile canvas
    if (tileStateRef.current?.canvas && fallbackRef.current) {
      ctx.drawImage(fallbackRef.current, 0, 0, fallbackRef.current.width, fallbackRef.current.height, dx, dy, dw, dh);
    }

    ctx.drawImage(source, 0, 0, source.width, source.height, dx, dy, dw, dh);
  }, [volume, z, t, c, offsetX, offsetY, zoom, storeVersion, datasetInfo, scene, store]);

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
      setOffsetX((prev) => prev + dx / zoom);
      setOffsetY((prev) => prev + dy / zoom);

      // Sync pan to WasmScene
      scene.pan(-dx, -dy);
    },
    [dragging, zoom, scene],
  );

  const onPointerUp = useCallback(() => {
    setDragging(false);
    // Request chunks for newly visible area after drag
    try {
      const plan = JSON.parse(scene.chunk_plan());
      if (plan.needed.length > 0) {
        store.ensureFetched(plan.needed);
      }
    } catch { /* ignore */ }
  }, [scene, store]);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = zoom * factor;

      const canvasW = canvas.clientWidth;
      const canvasH = canvas.clientHeight;

      const fullResWidth = datasetInfo.levels[0].shape[4];
      const fullResHeight = datasetInfo.levels[0].shape[3];
      const dataW = fullResWidth;
      const dataH = fullResHeight;

      const worldX = (cursorX - canvasW / 2) / zoom + dataW / 2 - offsetX;
      const worldY = (cursorY - canvasH / 2) / zoom + dataH / 2 - offsetY;

      const newOffsetX = dataW / 2 - worldX + (cursorX - canvasW / 2) / newZoom;
      const newOffsetY = dataH / 2 - worldY + (cursorY - canvasH / 2) / newZoom;

      setZoom(newZoom);
      setOffsetX(newOffsetX);
      setOffsetY(newOffsetY);

      scene.zoom_by(factor);
      // Sync Rust camera center to match the JS viewport offset
      scene.set_center(dataW / 2 - newOffsetX, dataH / 2 - newOffsetY);
      // ensureFetched will be triggered by the state change via the effect
    },
    [zoom, offsetX, offsetY, scene, datasetInfo],
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
