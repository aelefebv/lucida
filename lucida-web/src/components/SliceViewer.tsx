/** 2D slice viewer — delegates WebGPU rendering to a worker via RenderClient. */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { RenderClient } from "../renderer/renderClient.ts";
import { RenderLoop, type DatasetEntry } from "../renderLoop.ts";
import type { Session } from "../session.ts";
import { applyDocumentCommand, applyViewportCommand } from "../applyAndSend.ts";

interface Props {
  z: number;
  t: number;
  c: number;
  session: Session;
  scene: WasmScene;
  datasets: Map<string, DatasetEntry>;
  client: RenderClient;
  canvas: HTMLCanvasElement;
  remoteDocumentVersion: number;
  emitPresence: () => void;
  breakFollow: () => void;
  sendCursor: (position: [number, number] | null) => void;
  loopRef: RefObject<RenderLoop | null>;
  onLoopChange: (loop: RenderLoop | null) => void;
  /** Dataset to attach a dropped pin to (annotations are scoped per dataset). */
  annotationDatasetId: string | null;
  /** Local client id, recorded as the pin's author. */
  myId: number;
  /** Send a wire command (already wrapped by the bridge). */
  sendCommand: (json: string) => void;
  /** Notify the parent that the document changed locally (a pin was dropped)
   * so dependent overlays re-read. Mirrors the remote-document version bump. */
  onDocumentChanged: () => void;
}

/** Max pointer travel (CSS px) for a press+release to count as a click, not a drag. */
const PIN_CLICK_SLOP = 4;

export function SliceViewer({ z, t, c, session, scene, datasets, client, canvas, remoteDocumentVersion, emitPresence, breakFollow, sendCursor, loopRef: parentLoopRef, onLoopChange, annotationDatasetId, myId, sendCommand, onDocumentChanged }: Props) {
  const loopRef = useRef<RenderLoop | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });
  // Press context for distinguishing a pin-drop click from a pan drag.
  const pressStart = useRef<{ x: number; y: number; pin: boolean } | null>(null);

  // Mirror placement props into refs so the pointer handlers (which depend on
  // `canvas` only, to avoid re-binding listeners on every doc change) read the
  // latest values without stale closures.
  const annotationDatasetIdRef = useRef(annotationDatasetId);
  annotationDatasetIdRef.current = annotationDatasetId;
  const myIdRef = useRef(myId);
  myIdRef.current = myId;
  const sendCommandRef = useRef(sendCommand);
  sendCommandRef.current = sendCommand;
  const onDocumentChangedRef = useRef(onDocumentChanged);
  onDocumentChangedRef.current = onDocumentChanged;

  // Create/start render loop. Deliberately omits `datasets` (live mutable
  // Map shared with the parent — RenderLoop reads it each frame),
  // `onLoopChange` (stable parent callback), and `parentLoopRef` (a ref).
  // Re-creating the loop on those would tear down GPU state every frame.
  useEffect(() => {
    const loop = new RenderLoop({ session, datasets, client, canvas, mode: "slice" });
    loopRef.current = loop;
    parentLoopRef.current = loop;
    loop.start();
    onLoopChange(loop);
    return () => {
      loop.stop();
      parentLoopRef.current = null;
      onLoopChange(null);
    };
  }, [session, client, canvas]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loopRef.current?.setSliceParams(z, t, c);
  }, [z, t, c, scene, client, canvas]);

  useEffect(() => {
    loopRef.current?.markInteractiveDirty();
  }, [remoteDocumentVersion]);

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      // Shift-press begins a pin drop (placed on release if it stays a click).
      // A plain press begins a pan drag, exactly as before.
      const pin = e.shiftKey;
      pressStart.current = { x: e.clientX, y: e.clientY, pin };
      setDragging(!pin);
      lastPos.current = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    },
    [canvas],
  );

  /** Convert a pointer event to 2D world coords (inverse of the camera). */
  const eventToWorld = useCallback(
    (e: PointerEvent): [number, number] => {
      const dpr = devicePixelRatio;
      const rect = canvas.getBoundingClientRect();
      const cursorX = (e.clientX - rect.left) * dpr;
      const cursorY = (e.clientY - rect.top) * dpr;
      const zoom = scene.zoom();
      const centerArr = scene.center();
      const halfW = (canvas.clientWidth * dpr) / 2;
      const halfH = (canvas.clientHeight * dpr) / 2;
      return [(cursorX - halfW) / zoom + centerArr[0], (cursorY - halfH) / zoom + centerArr[1]];
    },
    [canvas, scene],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      // All coordinates scaled to physical pixels to match WASM viewport
      const dpr = devicePixelRatio;
      const rect = canvas.getBoundingClientRect();
      const cursorX = (e.clientX - rect.left) * dpr;
      const cursorY = (e.clientY - rect.top) * dpr;
      const zoom = scene.zoom();
      const centerArr = scene.center();
      const halfW = canvas.clientWidth * dpr / 2;
      const halfH = canvas.clientHeight * dpr / 2;
      const worldX = (cursorX - halfW) / zoom + centerArr[0];
      const worldY = (cursorY - halfH) / zoom + centerArr[1];
      sendCursor([worldX, worldY]);

      if (!dragging) return;
      const dx = (e.clientX - lastPos.current.x) * dpr;
      const dy = (e.clientY - lastPos.current.y) * dpr;
      lastPos.current = { x: e.clientX, y: e.clientY };
      const pdx = -dx;
      const pdy = -dy;
      breakFollow();
      applyViewportCommand(scene, { type: "pan", dx: pdx, dy: pdy });
      emitPresence();
      loopRef.current?.markInteractiveDirty();
    },
    [dragging, scene, canvas, emitPresence, breakFollow, sendCursor],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const press = pressStart.current;
      pressStart.current = null;
      setDragging(false);

      // Drop a pin only on a shift-press that stayed a click (didn't drag) and
      // when a dataset is selected to scope it to. World coords keep the pin
      // anchored to the data for every peer.
      if (
        press?.pin &&
        Math.hypot(e.clientX - press.x, e.clientY - press.y) <= PIN_CLICK_SLOP
      ) {
        const datasetId = annotationDatasetIdRef.current;
        if (datasetId) {
          const [worldX, worldY] = eventToWorld(e);
          const id = globalThis.crypto?.randomUUID
            ? globalThis.crypto.randomUUID()
            : `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
          // Apply locally AND send (mirrors applyDocumentCommand for every
          // other doc command): the sender is excluded from the server's
          // rebroadcast, so without the local apply the author would never
          // see their own pin. The client-supplied id makes the local apply
          // and the peers' broadcast converge on the same annotation.
          applyDocumentCommand(
            scene,
            {
              type: "add_annotation",
              dataset_id: datasetId,
              id,
              position: [worldX, worldY],
              author: String(myIdRef.current),
              kind: "point",
            },
            sendCommandRef.current,
          );
          onDocumentChangedRef.current();
          loopRef.current?.markInteractiveDirty();
        }
      }
    },
    [eventToWorld],
  );

  const onPointerCancel = useCallback(() => {
    // A cancelled gesture never drops a pin.
    pressStart.current = null;
    setDragging(false);
  }, []);

  const onPointerLeave = useCallback(() => {
    sendCursor(null);
  }, [sendCursor]);

  // Clear cursor on unmount (e.g. mode switch to 3D)
  useEffect(() => {
    return () => { sendCursor(null); };
  }, [sendCursor]);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();

      const dpr = devicePixelRatio;
      const rect = canvas.getBoundingClientRect();
      const cursorX = (e.clientX - rect.left) * dpr;
      const cursorY = (e.clientY - rect.top) * dpr;
      const canvasW = canvas.clientWidth * dpr;
      const canvasH = canvas.clientHeight * dpr;

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
      loopRef.current?.markInteractiveDirty();
    },
    [scene, canvas, emitPresence, breakFollow],
  );

  useEffect(() => {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    // Mutating canvas.style.cursor is the lightweight pattern for
    // grab/grabbing feedback during pointer drag — promoting cursor
    // state to the parent + a CSS class would re-render the whole
    // viewport tree on every drag transition.
    // eslint-disable-next-line react-hooks/immutability
    canvas.style.cursor = dragging ? "grabbing" : "grab";
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [canvas, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave, onWheel, dragging]);

  return null;
}
