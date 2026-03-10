/** 2D slice viewer — delegates WebGPU rendering to a worker via RenderClient. */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { WasmScene } from "lucida-core";
import type { VolumeData } from "../zarr/volumeAssembler.ts";
import { RenderClient } from "../renderer/renderClient.ts";
import { RenderLoop, type DatasetEntry } from "../renderLoop.ts";
import { applyViewportCommand } from "../applyAndSend.ts";

interface Props {
  volume: VolumeData;
  z: number;
  t: number;
  c: number;
  scene: WasmScene;
  datasets: Map<string, DatasetEntry>;
  selectedDatasetId: string;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  remoteDocumentVersion: number;
  emitPresence: () => void;
  breakFollow: () => void;
  loopRef: MutableRefObject<RenderLoop | null>;
}

export function SliceViewer({ volume, z, t, c, scene, datasets, selectedDatasetId, client, canvas, remoteDocumentVersion, emitPresence, breakFollow, loopRef: parentLoopRef }: Props) {
  const loopRef = useRef<RenderLoop | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // Create/start render loop
  useEffect(() => {
    const loop = new RenderLoop({ scene, datasets, selectedDatasetId, client, canvas, mode: "slice" });
    loopRef.current = loop;
    parentLoopRef.current = loop;
    loop.start();
    return () => {
      loop.stop();
      parentLoopRef.current = null;
    };
  }, [scene, selectedDatasetId, client, canvas]);

  // Update slice params on prop changes and when loop is recreated
  useEffect(() => {
    loopRef.current?.setSliceParams(z, t, c);
  }, [z, t, c, scene, selectedDatasetId, client, canvas]);

  // Mark dirty on remote document updates
  useEffect(() => {
    loopRef.current?.markDirty();
  }, [remoteDocumentVersion]);

  // Reset pan/zoom when the dataset dimensions change
  const prevDims = useRef({ w: volume.width, h: volume.height, d: volume.depth });
  useEffect(() => {
    const { width, height, depth } = volume;
    const prev = prevDims.current;
    if (width !== prev.w || height !== prev.h || depth !== prev.d) {
      prevDims.current = { w: width, h: height, d: depth };
      const selectedDs = datasets.get(selectedDatasetId);
      if (selectedDs) {
        const fullResWidth = selectedDs.info.levels[0].shape[4];
        const fullResHeight = selectedDs.info.levels[0].shape[3];
        applyViewportCommand(scene, { type: "set_center", x: fullResWidth / 2, y: fullResHeight / 2 });
        applyViewportCommand(scene, { type: "set_zoom", value: 1.0 });
        emitPresence();
        loopRef.current?.markDirty();
      }
    }
  }, [volume, scene, datasets, selectedDatasetId, emitPresence]);

  // Upload fallback (coarsest-level) texture
  useEffect(() => {
    const { width, height, depth, data } = volume;
    const clampedZ = Math.max(0, Math.min(z, depth - 1));
    const sliceSize = width * height;
    const offset = clampedZ * sliceSize;
    const slice = data.subarray(offset, offset + sliceSize);
    client.sliceSetFallbackForLayer(selectedDatasetId, slice, width, height);
  }, [volume, z, client, selectedDatasetId]);

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
      breakFollow();
      applyViewportCommand(scene, { type: "pan", dx: pdx, dy: pdy });
      emitPresence();
      loopRef.current?.markDirty();
    },
    [dragging, scene, emitPresence, breakFollow],
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
      breakFollow();
      applyViewportCommand(scene, { type: "zoom_by", factor });
      const newZoom = scene.zoom();

      const newCx = worldX - (cursorX - canvasW / 2) / newZoom;
      const newCy = worldY - (cursorY - canvasH / 2) / newZoom;
      applyViewportCommand(scene, { type: "set_center", x: newCx, y: newCy });
      emitPresence();
      loopRef.current?.markDirty();
    },
    [scene, canvas, emitPresence, breakFollow],
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
