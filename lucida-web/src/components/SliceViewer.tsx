/** 2D slice viewer. WebGPU rendering runs in a worker via RenderClient. */
import { memo, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { SLICE_ZOOM_IN_PER_NOTCH, SLICE_ZOOM_OUT_PER_NOTCH } from "./inputScale.ts";
import type { WasmScene } from "lucida-core";
import { RenderClient } from "../renderer/renderClient.ts";
import { RenderLoop, type DatasetEntry } from "../renderLoop.ts";
import type { Session } from "../session.ts";
import { applyDocumentCommand, applyViewportCommand, frameOnCanvas } from "../applyAndSend.ts";
import { buildAnnotationView } from "../savedView/buildAnnotationView.ts";
import type { AnnotationDraft } from "./annotationDraft.ts";
import { exceedsClickSlop } from "./annotationInteraction.ts";
import { isShapeKind, pressAnnotationKind, type AnnotationKind, type Tool } from "./annotationTool.ts";
import { eventToWorld as sceneEventToWorld, type ClientPoint } from "./cameraProjection.ts";
import { clientPoint, useTouchGestures } from "../input/useTouchGestures.ts";
import { useCommand } from "../ui/commands.ts";
import { pushEscapeLayer } from "../ui/escape.ts";
import { comboFromEvent, useShortcut } from "../ui/shortcuts.ts";
import { readResolvedLayers, shownChannels } from "../resolvedLayers.ts";
import { readPlacement, sceneToFrame } from "../placement.ts";

/** An arrow key pans by this share of the canvas's shorter side. */
const KEY_PAN_FRACTION = 0.1;
/** `+` and `-` zoom about the center by this factor. */
const KEY_ZOOM_FACTOR = 1.25;
/** A double tap zooms in, and a two-finger tap out, by this factor. */
const TAP_ZOOM_FACTOR = 2;
/** Which way each arrow moves the camera, so the image moves the other way. */
const PAN_DIRECTIONS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
const ARROW_KEY_CONTROLS = 'input[type="range"], input[type="radio"], [role="slider"]';

interface Props {
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
   * `author`. From `annotationAuthorId()`, not the per-connection `myId`,
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
  /** A touch long press on the canvas, at its client point. */
  onLongPress?: (at: ClientPoint) => void;
}

function SliceViewerBody({ session, scene, datasets, client, canvas, remoteDocumentVersion, emitPresence, breakFollow, sendCursor, loopRef: parentLoopRef, onLoopChange, annotationDatasetId, tool, myId, sendCommand, onDocumentChanged, annotationDraftRef, onLongPress }: Props) {
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
  // `canvas` only, read the latest values without re-binding on every doc
  // change.
  const annotationDatasetIdRef = useRef(annotationDatasetId);
  const toolRef = useRef(tool);
  const myIdRef = useRef(myId);
  const sendCommandRef = useRef(sendCommand);
  const onDocumentChangedRef = useRef(onDocumentChanged);
  const onLongPressRef = useRef(onLongPress);
  // Refreshed after every commit, not during render: these refs are read only in
  // pointer events and RAF ticks, so render stays free of ref writes.
  useEffect(() => {
    annotationDatasetIdRef.current = annotationDatasetId;
    toolRef.current = tool;
    myIdRef.current = myId;
    sendCommandRef.current = sendCommand;
    onDocumentChangedRef.current = onDocumentChanged;
    onLongPressRef.current = onLongPress;
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
    loopRef.current?.markInteractiveDirty();
  }, [remoteDocumentVersion]);

  /** Convert a pointer event to 2D world coords via the shared inverse camera
   * projection. */
  const eventToWorld = useCallback(
    (e: ClientPoint): [number, number] => sceneEventToWorld(scene, canvas, e),
    [canvas, scene],
  );

  // Escape mid-press abandons it: no annotation lands on release.
  const cancelPress = useCallback(() => {
    pressStart.current?.endEscape();
    pressStart.current = null;
    setDragging(false);
    annotationDraftRef.current = null;
  }, [annotationDraftRef]);

  // A press, from a mouse, a pen, or a finger drawing with a tool. Touch
  // navigation goes through the gesture recognizer instead, so the pointer
  // handlers skip touch.
  const beginPress = useCallback(
    (e: ClientPoint, shiftKey: boolean) => {
      pressStart.current?.endEscape();
      const kind = pressAnnotationKind(toolRef.current, shiftKey);
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
    },
    [eventToWorld, cancelPress],
  );

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      // The right button opens the canvas menu instead.
      if (e.pointerType === "touch" || e.button === 2) return;
      beginPress(e, e.shiftKey);
      canvas.setPointerCapture(e.pointerId);
    },
    [canvas, beginPress],
  );

  const movePress = useCallback(
    (e: ClientPoint, atMs?: number) => {
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
      loopRef.current?.markInput("pan", atMs);
    },
    [scene, canvas, emitPresence, breakFollow, sendCursor, annotationDraftRef, eventToWorld],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (e.pointerType !== "touch") movePress(e, e.timeStamp);
    },
    [movePress],
  );

  const endPress = useCallback(
    (e: ClientPoint) => {
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
      // A pin is stored in its dataset's frame, wherever the scene places it.
      const placement = readPlacement(scene, datasetId);
      const start = sceneToFrame(placement, press.world);
      const end = sceneToFrame(placement, eventToWorld(e));
      // Snapshot the author's view onto the pin so navigation can restore it.
      // A null capture just omits the view.
      const capturedView = buildAnnotationView(scene);
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
          position: drawShape ? start : end,
          end: drawShape ? end : null,
          z: scene.z(),
          // The overlay shows the pin off-context when the view's T differs or
          // none of the channels its layer shows now did then.
          t: scene.t(),
          c: shownChannels(readResolvedLayers(scene).get(datasetId))[0],
          author: String(myIdRef.current),
          kind: drawShape ? kind : "point",
          ...(capturedView ? { view: capturedView } : {}),
        },
        sendCommandRef.current,
        loopRef.current,
      );
      onDocumentChangedRef.current();
    },
    [eventToWorld, scene, annotationDraftRef],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      if (e.pointerType !== "touch") endPress(e);
    },
    [endPress],
  );

  // A cancelled gesture never drops a pin.
  const onPointerCancel = useCallback(
    (e: PointerEvent) => {
      if (e.pointerType !== "touch") cancelPress();
    },
    [cancelPress],
  );

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
      loopRef.current?.markInput("zoom", e.timeStamp);
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

  /** Zoom by `factor`, moving the world point under `from` to `to`: the wheel's
   * anchoring, with room for the fingers to travel while they pinch. */
  const zoomBetween = (from: ClientPoint, to: ClientPoint, factor: number) => {
    const dpr = devicePixelRatio;
    const rect = canvas.getBoundingClientRect();
    const [worldX, worldY] = sceneEventToWorld(scene, canvas, from);
    applyViewportCommand(scene, { type: "zoom_by", factor });
    const zoom = scene.zoom();
    const offsetX = (to.clientX - rect.left) * dpr - (canvas.clientWidth * dpr) / 2;
    const offsetY = (to.clientY - rect.top) * dpr - (canvas.clientHeight * dpr) / 2;
    applyViewportCommand(scene, { type: "set_center", x: worldX - offsetX / zoom, y: worldY - offsetY / zoom });
  };

  // One finger pans, or draws with a tool; two pinch and pan in one move.
  useTouchGestures(canvas, true, {
    claimsPress: () => toolRef.current !== "pan",
    onGesture: (g) => {
      switch (g.type) {
        case "pressStart":
          beginPress(clientPoint(g), false);
          break;
        case "pressMove":
          movePress(clientPoint(g));
          break;
        case "pressEnd":
          endPress(clientPoint(g));
          break;
        case "pressCancel":
          cancelPress();
          break;
        case "drag": {
          const dpr = devicePixelRatio;
          moveView(() => applyViewportCommand(scene, { type: "pan", dx: -g.dx * dpr, dy: -g.dy * dpr }), "pan");
          sendCursor(eventToWorld(clientPoint(g)));
          break;
        }
        case "pinch": {
          const from = { clientX: g.x - g.dx, clientY: g.y - g.dy };
          moveView(() => zoomBetween(from, clientPoint(g), g.scale), g.scale === 1 ? "pan" : "zoom");
          sendCursor(eventToWorld(clientPoint(g)));
          break;
        }
        case "doubleTap":
          moveView(() => zoomBetween(clientPoint(g), clientPoint(g), TAP_ZOOM_FACTOR), "zoom");
          break;
        case "twoFingerTap":
          moveView(() => zoomBetween(clientPoint(g), clientPoint(g), 1 / TAP_ZOOM_FACTOR), "zoom");
          break;
        case "longPress":
          onLongPressRef.current?.(clientPoint(g));
          break;
      }
    },
  });

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
    run: () => moveView(() => frameOnCanvas(scene, canvas), "zoom"),
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

// Memoized so a viewer render that changes none of its props, such as one
// for a peer's message, skips it; its props are stable for that reason.
export const SliceViewer = memo(SliceViewerBody);
