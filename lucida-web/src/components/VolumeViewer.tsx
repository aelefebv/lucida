/** 3D volume viewer — delegates WebGPU rendering to a worker via RenderClient. */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { RenderClient } from "../renderer/renderClient.ts";
import { RenderLoop, type DatasetEntry } from "../renderLoop.ts";
import { applyViewportCommand } from "../applyAndSend.ts";

interface Props {
  scene: WasmScene;
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  remoteDocumentVersion: number;
  emitPresence: () => void;
  breakFollow: () => void;
  sendCursor: (position: [number, number] | null) => void;
  t: number;
  c: number;
  loopRef: RefObject<RenderLoop | null>;
  onLoopChange: (loop: RenderLoop | null) => void;
}

export function VolumeViewer({ scene, datasets, client, canvas, remoteDocumentVersion, emitPresence, breakFollow, sendCursor, t, c, loopRef: parentLoopRef, onLoopChange }: Props) {
  const loopRef = useRef<RenderLoop | null>(null);

  // Create/start render loop
  useEffect(() => {
    const loop = new RenderLoop({ scene, datasets, client, canvas, mode: "volume" });
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

  // Mark dirty on remote document updates
  useEffect(() => {
    loopRef.current?.markDirty();
  }, [remoteDocumentVersion]);

  // Mark dirty on T/C changes so the render loop re-evaluates chunks
  useEffect(() => {
    loopRef.current?.markDirty();
  }, [t, c]);

  // Resolution scaling during interaction
  const scaleTimerRef = useRef<number>(0);
  const setLowRes = useCallback(() => {
    clearTimeout(scaleTimerRef.current);
    loopRef.current?.setRenderScale(0.25);
  }, []);
  const scheduleFullRes = useCallback(() => {
    clearTimeout(scaleTimerRef.current);
    scaleTimerRef.current = window.setTimeout(() => {
      loopRef.current?.setRenderScale(1.0);
    }, 50);
  }, []);
  useEffect(() => () => clearTimeout(scaleTimerRef.current), []);

  // Input handling
  const [dragging, setDragging] = useState(false);
  const shiftDragRef = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      setDragging(true);
      shiftDragRef.current = e.shiftKey;
      lastPos.current = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      setLowRes();
    },
    [canvas, setLowRes],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      // Always broadcast cursor as normalized screen coordinates
      const rect = canvas.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / canvas.clientWidth;
      const ny = (e.clientY - rect.top) / canvas.clientHeight;
      sendCursor([nx, ny]);

      if (!dragging) return;
      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      lastPos.current = { x: e.clientX, y: e.clientY };

      breakFollow();
      if (shiftDragRef.current) {
        applyViewportCommand(scene, { type: "pan_3d", dx, dy });
      } else {
        const dTheta = -dx * 0.005;
        const dPhi = -dy * 0.005;
        applyViewportCommand(scene, { type: "rotate_3d", d_theta: dTheta, d_phi: dPhi });
      }
      emitPresence();
      loopRef.current?.markDirty();
    },
    [dragging, scene, canvas, emitPresence, breakFollow, sendCursor],
  );

  const onPointerUp = useCallback(() => {
    setDragging(false);
    scheduleFullRes();
  }, [scheduleFullRes]);

  const onPointerLeave = useCallback(() => {
    sendCursor(null);
  }, [sendCursor]);

  // Clear cursor on unmount (e.g. mode switch to 2D)
  useEffect(() => {
    return () => { sendCursor(null); };
  }, [sendCursor]);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY * 0.001;
      breakFollow();
      applyViewportCommand(scene, { type: "zoom_3d", delta });
      emitPresence();
      loopRef.current?.markDirty();
      setLowRes();
      scheduleFullRes();
    },
    [scene, emitPresence, breakFollow, setLowRes, scheduleFullRes],
  );

  // Attach event handlers to the shared canvas
  useEffect(() => {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.style.cursor = dragging ? "grabbing" : "grab";
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [canvas, onPointerDown, onPointerMove, onPointerUp, onPointerLeave, onWheel, dragging]);

  return null;
}
