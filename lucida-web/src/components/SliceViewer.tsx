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
import { isShapeKind, pressAnnotationKind, type AnnotationKind, type Tool } from "./annotationTool.ts";
import { eventToWorld as sceneEventToWorld } from "./cameraProjection.ts";
import { useCommand } from "../ui/commands.ts";
import { pushEscapeLayer } from "../ui/escape.ts";
import { comboFromEvent, useShortcut } from "../ui/shortcuts.ts";

/** An arrow key pans by this share of the canvas's shorter side. */
const KEY_PAN_FRACTION = 0.1;
/** `+` and `-` zoom about the center by this factor. */
const KEY_ZOOM_FACTOR = 1.25;
/** Which way each arrow moves the camera, so the image moves the other way. */
const PAN_DIRECTIONS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
const ARROW_KEY_CONTROLS = 'input[type="range"], input[type="radio"], [role="slider"]';

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
  /** The canvas tool: pan, or the annotation shape a press draws. */
  tool: Tool;
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

export function SliceViewer({ z, t, c, session, scene, datasets, client, canvas, remoteDocumentVersion, emitPresence, breakFollow, sendCursor, loopRef: parentLoopRef, onLoopChange, annotationDatasetId, tool, myId, sendCommand, onDocumentChanged, annotationDraftRef }: Props) {
  const loopRef = useRef<RenderLoop | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef({ x: 0, y: 0 });
  // The press in progress. `kind` is what it draws (null when it pans), fixed
  // at press time so a tool change mid-drag can't reshape it; `panning` turns
  // on at once for a pan and past the click slop for a point; `world` is a
  // line or box's first vertex; `endEscape` drops the press's Escape layer.
  const pressStart = useRef<{
    x: number;
    y: number;
    kind: AnnotationKind | null;
    panning: boolean;
    world: [number, number];
    endEscape: () => void;
  } | null>(null);

  // Mirror placement props into refs so the pointer handlers, which depend on
  // `canvas` only, read the latest values without re-binding on every doc or
  // slice change. A dropped pin records its Z/T/C from these.
  const annotationDatasetIdRef = useRef(annotationDatasetId);
  const toolRef = useRef(tool);
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
    toolRef.current = tool;
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

  // Escape mid-press abandons it: no annotation lands on release.
  const cancelPress = useCallback(() => {
    pressStart.current?.endEscape();
    pressStart.current = null;
    setDragging(false);
    annotationDraftRef.current = null;
  }, [annotationDraftRef]);

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      pressStart.current?.endEscape();
      const kind = pressAnnotationKind(toolRef.current, e.shiftKey);
      pressStart.current = {
        x: e.clientX,
        y: e.clientY,
        kind,
        panning: kind === null,
        world: eventToWorld(e),
        endEscape: kind === null ? () => {} : pushEscapeLayer(cancelPress),
      };
      setDragging(kind === null);
      lastPos.current = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    },
    [canvas, eventToWorld, cancelPress],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const dpr = devicePixelRatio;
      const rect = canvas.getBoundingClientRect();
      sendCursor(eventToWorld(e));

      const press = pressStart.current;
      if (!press) return;
      const pastSlop = exceedsClickSlop(press.x, press.y, e.clientX, e.clientY);
      // Live line/box preview. Below the click slop it stays null, since a
      // sub-slop release drops a point and the preview shouldn't flash a shape.
      if (isShapeKind(press.kind)) {
        annotationDraftRef.current = pastSlop
          ? { kind: press.kind, x0: press.x - rect.left, y0: press.y - rect.top, x1: e.clientX - rect.left, y1: e.clientY - rect.top }
          : null;
        return;
      }
      // A point press that travels becomes a pan, so the point tool never
      // traps navigation. The pan starts from the press, keeping the image
      // under the pointer.
      if (press.kind === "point" && !press.panning && pastSlop) {
        press.panning = true;
        press.endEscape();
        setDragging(true);
      }

      if (!press.panning) return;
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
    [scene, canvas, emitPresence, breakFollow, sendCursor, annotationDraftRef, eventToWorld],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const press = pressStart.current;
      pressStart.current = null;
      press?.endEscape();
      setDragging(false);
      annotationDraftRef.current = null;

      if (!press || press.kind === null || press.panning) return;
      const datasetId = annotationDatasetIdRef.current;
      if (!datasetId) return;

      // A line/box that never left the slop drops a point instead, so a stray
      // click never leaves an invisible zero-size shape.
      const kind = press.kind;
      const drawShape = isShapeKind(kind) && exceedsClickSlop(press.x, press.y, e.clientX, e.clientY);

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

  // A cancelled gesture never drops a pin.
  const onPointerCancel = cancelPress;

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

  // The keyboard moves the view about its center, as the toolbar would.
  const moveView = (move: () => void, input: "pan" | "zoom") => {
    breakFollow();
    move();
    emitPresence();
    loopRef.current?.markInput(input);
  };

  useShortcut({
    id: "view.pan",
    keys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"],
    label: "Pan",
    group: "View",
    repeat: true,
    // A focused native slider or radio moves on its own arrow keys.
    when: () => !document.activeElement?.matches(ARROW_KEY_CONTROLS),
    onTrigger: (event) => {
      const step = KEY_PAN_FRACTION * Math.min(canvas.clientWidth, canvas.clientHeight) * devicePixelRatio;
      const [dx, dy] = PAN_DIRECTIONS[comboFromEvent(event) ?? ""] ?? [0, 0];
      moveView(() => applyViewportCommand(scene, { type: "pan", dx: dx * step, dy: dy * step }), "pan");
    },
  });
  useCommand({
    id: "view.zoomIn",
    label: "Zoom in",
    group: "View",
    keys: ["+", "="],
    repeat: true,
    run: () => moveView(() => applyViewportCommand(scene, { type: "zoom_by", factor: KEY_ZOOM_FACTOR }), "zoom"),
  });
  useCommand({
    id: "view.zoomOut",
    label: "Zoom out",
    group: "View",
    keys: ["-"],
    repeat: true,
    run: () => moveView(() => applyViewportCommand(scene, { type: "zoom_by", factor: 1 / KEY_ZOOM_FACTOR }), "zoom"),
  });
  useCommand({
    id: "view.fit",
    label: "Fit to view",
    group: "View",
    keys: ["0"],
    keywords: ["reset", "frame", "home"],
    run: () => {
      const datasetId = annotationDatasetIdRef.current ?? datasets.keys().next().value;
      if (!datasetId) return;
      moveView(() => {
        try {
          scene.fit_camera_to_dataset_bounds(datasetId);
        } catch {
          // A dataset with nothing loaded yet has no bounds; the view stays.
        }
      }, "zoom");
    },
  });

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
    canvas.style.cursor = dragging ? "grabbing" : tool === "pan" ? "grab" : "crosshair";
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [canvas, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave, onWheel, dragging, tool]);

  return null;
}
