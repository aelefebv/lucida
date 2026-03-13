/** 2D slice viewer — delegates WebGPU rendering to a worker via RenderClient. */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { RenderClient } from "../renderer/renderClient.ts";
import { RenderLoop, type DatasetEntry } from "../renderLoop.ts";
import { applyViewportCommand } from "../applyAndSend.ts";

interface Props {
  z: number;
  t: number;
  c: number;
  scene: WasmScene;
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  remoteDocumentVersion: number;
  emitPresence: () => void;
  breakFollow: () => void;
  loopRef: RefObject<RenderLoop | null>;
  onLoopChange: (loop: RenderLoop | null) => void;
}

function clampCenterToBounds(scene: WasmScene, canvas: HTMLCanvasElement, datasets: Map<string, DatasetEntry>) {
  const zoom = scene.zoom();
  const center = scene.center();
  const halfW = canvas.clientWidth / (2 * zoom);
  const halfH = canvas.clientHeight / (2 * zoom);

  // Find max dataset dimensions (voxel space)
  let maxW = 0, maxH = 0;
  for (const [, ds] of datasets) {
    const shape = ds.info.levels[0].shape; // [T, C, Z, Y, X]
    maxW = Math.max(maxW, shape[4]);
    maxH = Math.max(maxH, shape[3]);
  }
  if (maxW === 0 || maxH === 0) return;

  // Clamp: left side of camera ≤ right side of volume, right side ≥ left side, etc.
  const cx = Math.max(-halfW, Math.min(maxW + halfW, center[0]));
  const cy = Math.max(-halfH, Math.min(maxH + halfH, center[1]));
  if (cx !== center[0] || cy !== center[1]) {
    scene.set_center(cx, cy);
  }
}

export function SliceViewer({ z, t, c, scene, datasets, client, canvas, remoteDocumentVersion, emitPresence, breakFollow, loopRef: parentLoopRef, onLoopChange }: Props) {
  const loopRef = useRef<RenderLoop | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // Create/start render loop
  useEffect(() => {
    const loop = new RenderLoop({ scene, datasets, client, canvas, mode: "slice" });
    loopRef.current = loop;
    parentLoopRef.current = loop;
    loop.start();
    onLoopChange(loop);
    return () => {
      loop.stop();
      parentLoopRef.current = null;
      onLoopChange(null);
    };
  }, [scene, client, canvas]);

  // Update slice params on prop changes and when loop is recreated
  useEffect(() => {
    loopRef.current?.setSliceParams(z, t, c);
  }, [z, t, c, scene, client, canvas]);

  // Mark dirty on remote document updates
  useEffect(() => {
    loopRef.current?.markDirty();
  }, [remoteDocumentVersion]);

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
      clampCenterToBounds(scene, canvas, datasets);
      emitPresence();
      loopRef.current?.markDirty();
    },
    [dragging, scene, canvas, datasets, emitPresence, breakFollow],
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
      clampCenterToBounds(scene, canvas, datasets);
      emitPresence();
      loopRef.current?.markDirty();
    },
    [scene, canvas, datasets, emitPresence, breakFollow],
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
