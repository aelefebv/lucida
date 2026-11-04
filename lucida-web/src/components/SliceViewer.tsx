/** 2D slice viewer. WebGPU rendering runs in a worker via RenderClient. */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { SLICE_ZOOM_IN_PER_NOTCH, SLICE_ZOOM_OUT_PER_NOTCH } from "./inputScale.ts";
import type { WasmScene } from "lucida-core";
import { RenderClient } from "../renderer/renderClient.ts";
import { RenderLoop, type DatasetEntry } from "../renderLoop.ts";
import type { Session } from "../session.ts";
import { applyDocumentCommand, applyViewportCommand } from "../applyAndSend.ts";
import { buildAnnotationView, liveViewWithLiveZTC } from "../savedView/buildAnnotationView.ts";
import type { AnnotationDraft } from "./annotationDraft.ts";
import { exceedsClickSlop } from "./annotationInteraction.ts";
import { eventToWorld as sceneEventToWorld } from "./cameraProjection.ts";

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
  /** Shape a shift-drag draws: a point pin, a line, or a box. */
  annotationKind: "point" | "line" | "box";
  /** Stable, browser-persisted annotation-author identity, recorded as a pin's
   * `author`. From `annotationAuthorId()`, not the per-connection `bridge.myId`,
   * so pins stay yours across leaving and rejoining a workspace. */
  myId: string;
  /** Send a wire command (already wrapped by the bridge). */
  sendCommand: (json: string) => void;
  /** Notify the parent that the document changed locally (a pin was dropped)
   * so dependent overlays re-read. */
  onDocumentChanged: () => void;
  /** Live box/line draw preview in canvas-relative CSS px, rendered by
   * {@link AnnotationDraftOverlay}. Cleared on release or cancel. */
  annotationDraftRef: RefObject<AnnotationDraft | null>;
}

export function SliceViewer({ z, t, c, session, scene, datasets, client, canvas, remoteDocumentVersion, emitPresence, breakFollow, sendCursor, loopRef: parentLoopRef, onLoopChange, annotationDatasetId, annotationKind, myId, sendCommand, onDocumentChanged, annotationDraftRef }: Props) {
  const loopRef = useRef<RenderLoop | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });
  // Press context for distinguishing a pin-drop click from a pan drag, and for
  // anchoring a line/box draw at the press point. `world` is the start vertex.
  const pressStart = useRef<{ x: number; y: number; pin: boolean; world: [number, number] } | null>(null);

  // Mirror placement props into refs so the pointer handlers, which depend on
  // `canvas` only, read the latest values without re-binding on every doc or
  // slice change. A dropped pin records its Z/T/C from these.
  const annotationDatasetIdRef = useRef(annotationDatasetId);
  const annotationKindRef = useRef(annotationKind);
  const zRef = useRef(z);
  const tRef = useRef(t);
  const cRef = useRef(c);
  const myIdRef = useRef(myId);
  const sendCommandRef = useRef(sendCommand);
  const onDocumentChangedRef = useRef(onDocumentChanged);
  // Refreshed after every commit, not during render: these refs are read only in
  // pointer events and RAF ticks, so render stays free of ref writes.
  useEffect(() => {
    annotationDatasetIdRef.current = annotationDatasetId;
    annotationKindRef.current = annotationKind;
    zRef.current = z;
    tRef.current = t;
    cRef.current = c;
    myIdRef.current = myId;
    sendCommandRef.current = sendCommand;
    onDocumentChangedRef.current = onDocumentChanged;
  });

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

  /** Convert a pointer event to 2D world coords via the shared inverse camera
   * projection. */
  const eventToWorld = useCallback(
    (e: PointerEvent): [number, number] => sceneEventToWorld(scene, canvas, e),
    [canvas, scene],
  );

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      // Shift-press begins an annotation draw and never pans; a plain press
      // pans. The press point is kept in world space so a line/box can use it
      // as its first vertex.
      const pin = e.shiftKey;
      pressStart.current = { x: e.clientX, y: e.clientY, pin, world: eventToWorld(e) };
      setDragging(!pin);
      lastPos.current = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    },
    [canvas, eventToWorld],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const dpr = devicePixelRatio;
      const rect = canvas.getBoundingClientRect();
      sendCursor(eventToWorld(e));

      // Live line/box preview. Below the click slop it stays null, since a
      // sub-slop release drops a point and the preview shouldn't flash a shape.
      const press = pressStart.current;
      if (press?.pin) {
        const drawKind = annotationKindRef.current;
        annotationDraftRef.current =
          (drawKind === "line" || drawKind === "box") &&
          exceedsClickSlop(press.x, press.y, e.clientX, e.clientY)
            ? { kind: drawKind, x0: press.x - rect.left, y0: press.y - rect.top, x1: e.clientX - rect.left, y1: e.clientY - rect.top }
            : null;
      }

      if (!dragging) return;
      const dx = (e.clientX - lastPos.current.x) * dpr;
      const dy = (e.clientY - lastPos.current.y) * dpr;
      lastPos.current = { x: e.clientX, y: e.clientY };
      const pdx = -dx;
      const pdy = -dy;
      breakFollow();
      applyViewportCommand(scene, { type: "pan", dx: pdx, dy: pdy });
      emitPresence();
      loopRef.current?.markInput("pan");
    },
    [dragging, scene, canvas, emitPresence, breakFollow, sendCursor, annotationDraftRef, eventToWorld],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const press = pressStart.current;
      pressStart.current = null;
      setDragging(false);
      annotationDraftRef.current = null;

      if (!press?.pin) return;
      const datasetId = annotationDatasetIdRef.current;
      if (!datasetId) return;

      const pastSlop = exceedsClickSlop(press.x, press.y, e.clientX, e.clientY);
      const kind = annotationKindRef.current;
      // A line/box that never left the slop drops a point instead, so a stray
      // shift-click never leaves an invisible zero-size shape. A point-kind drag
      // is a no-op.
      const drawShape = (kind === "line" || kind === "box") && pastSlop;
      const dropPoint = !drawShape && !pastSlop;
      if (!drawShape && !dropPoint) return;

      const id = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const end = eventToWorld(e);
      // Snapshot the author's view onto the pin so navigation can restore it.
      // Z/T/C come from the slider refs, but slab thickness and `multi_channel`
      // come from the scene's presence, so a multi-plane or multi-channel view
      // isn't collapsed. A null capture just omits the view.
      const capturedView = buildAnnotationView(
        scene,
        liveViewWithLiveZTC(scene, zRef.current, tRef.current, cRef.current),
      );
      // Apply locally and send: the server's rebroadcast excludes the sender, so
      // without the local apply the author would never see their shape. The
      // client-supplied id makes the local and peer copies converge.
      //
      // Both vertices share the current slice depth `z`, which anchors the
      // shape in 3D. A pin stored without z/end loads as a point at z = 0.0.
      applyDocumentCommand(
        scene,
        {
          type: "add_annotation",
          dataset_id: datasetId,
          id,
          // A point anchors at the release; a line/box at the press, with `end`
          // at the release.
          position: drawShape ? press.world : end,
          end: drawShape ? end : null,
          z: zRef.current,
          // The overlay shows the pin off-context when the view's T/C differ.
          t: tRef.current,
          c: cRef.current,
          author: String(myIdRef.current),
          kind: drawShape ? kind : "point",
          ...(capturedView ? { view: capturedView } : {}),
        },
        sendCommandRef.current,
      );
      onDocumentChangedRef.current();
      loopRef.current?.markInteractiveDirty();
    },
    [eventToWorld, scene, annotationDraftRef],
  );

  const onPointerCancel = useCallback(() => {
    // A cancelled gesture never drops a pin.
    pressStart.current = null;
    setDragging(false);
    annotationDraftRef.current = null;
  }, [annotationDraftRef]);

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

      // The zoom anchor, read before the zoom changes the camera.
      const [worldX, worldY] = sceneEventToWorld(scene, canvas, e);

      const factor = e.deltaY > 0 ? SLICE_ZOOM_OUT_PER_NOTCH : SLICE_ZOOM_IN_PER_NOTCH;
      breakFollow();
      applyViewportCommand(scene, { type: "zoom_by", factor });
      const newZoom = scene.zoom();

      const newCx = worldX - (cursorX - canvasW / 2) / newZoom;
      const newCy = worldY - (cursorY - canvasH / 2) / newZoom;
      applyViewportCommand(scene, { type: "set_center", x: newCx, y: newCy });
      emitPresence();
      loopRef.current?.markInput("zoom");
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
