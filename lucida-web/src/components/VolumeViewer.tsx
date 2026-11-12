/** 3D volume viewer. WebGPU rendering runs in a worker via RenderClient. */
import { memo, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ORBIT_RADIANS_PER_PIXEL } from "./inputScale.ts";
import type { WasmScene } from "lucida-core";
import type { RenderLoop } from "../renderLoop.ts";
import { applyDocumentCommand, applyViewportCommand, frameOnCanvas } from "../applyAndSend.ts";
import { buildAnnotationView } from "../savedView/buildAnnotationView.ts";
import { useHeldKeys } from "../hooks/useHeldKeys.ts";
import { CLIP_BINDINGS, FLY_BINDINGS, TOGGLE_FLY_KEYS } from "../config/keyBindings.ts";
import { useFlyCameraInput } from "../hooks/useFlyCameraInput.ts";
import { useFineInputAvailable } from "../input/fineInput.ts";
import { useCommand } from "../ui/commands.ts";
import { pushEscapeLayer } from "../ui/escape.ts";
import { useShortcutScope } from "../ui/shortcuts.ts";
import { FlyCameraHint } from "./FlyCameraHint.tsx";
import type { AnnotationDraft } from "./annotationDraft.ts";
import { exceedsClickSlop } from "./annotationInteraction.ts";
import { annotationTarget, sayNoLayerToAnnotate } from "./annotationTarget.ts";
import { drawsOnPress, isShapeKind, pressAnnotationKind, type AnnotationKind, type Tool } from "./annotationTool.ts";
import { pickFramePoint, type ClientPoint, type ViewSurface } from "./cameraProjection.ts";
import { clientPoint, useTouchGestures } from "../input/useTouchGestures.ts";
import { wheelZoom } from "../input/wheel.ts";
import { frameClock } from "../frameClock.ts";
import { requestRender } from "../invalidation.ts";
import type { CameraMode } from "../sceneStore.ts";
import { readResolvedLayers, shownChannels } from "../resolvedLayers.ts";
import { FULL_RENDER_SCALE, GESTURE_RESTORE_DELAY_MS, INTERACTION_RENDER_SCALE, SCALE_RESTORE_DELAY_MS } from "./volumeRenderScale.ts";

interface Props {
  scene: WasmScene;
  /** The view this takes input for, and the element over its rectangle. */
  surface: ViewSurface;
  /** The canvas every view divides, which a fit sizes the scene to. */
  canvas: HTMLCanvasElement;
  /** Whether it is the active view, the one keyboard shortcuts steer. */
  active: boolean;
  emitPresence: () => void;
  breakFollow: () => void;
  sendCursor: (position: [number, number] | null) => void;
  /** The view's camera mode. A control outside this viewer or a restored
   *  view can switch it too. */
  cameraMode: CameraMode;
  loopRef: RefObject<RenderLoop | null>;
  /** The layer panel's selected layer, which a mark lands on where this view
   * draws it under the pointer ({@link annotationTarget}). */
  selectedDatasetId: string | null;
  /** Select the layer a mark landed on, so the panel's list and edit controls follow it. */
  selectDataset: (datasetId: string) => void;
  /** The canvas tool: pan, or the annotation shape a press draws. */
  tool: Tool;
  /** Stable, browser-persisted annotation-author identity, recorded as a 3D pin's
   * `author`. From `annotationAuthorId()`, not the per-connection `myId`,
   * so pins stay yours across leaving and rejoining a workspace. */
  myId: string;
  /** Send a wire command (already wrapped by the bridge). */
  sendCommand: (json: string) => void;
  /** Notify the parent that the document changed locally (a pin was dropped). */
  onDocumentChanged: () => void;
  /** Shared channel for the live box/line draw preview (screen-space CSS px,
   * relative to the canvas), rendered by {@link AnnotationDraftOverlay}; the
   * shift-drag writes it and clears it on release/cancel. */
  annotationDraftRef: RefObject<AnnotationDraft | null>;
  /** A touch long press on the canvas, at its client point. */
  onLongPress?: (at: ClientPoint) => void;
}

const CLIP_SPEED = 0.02; // world-space units per frame at 60 fps

function VolumeViewerBody({ scene, surface, canvas, active, emitPresence, breakFollow, sendCursor, cameraMode, loopRef, selectedDatasetId, selectDataset, tool, myId, sendCommand, onDocumentChanged, annotationDraftRef, onLongPress }: Props) {
  // The view's own element: its pixels, its pointer events, its cursor.
  const { element } = surface;
  const [showHint, setShowHint] = useState(false);

  // Mirror pin-drop props into refs so the element-bound pointer handlers read the
  // latest values without re-binding on every doc change.
  const selectedDatasetIdRef = useRef(selectedDatasetId);
  // eslint-disable-next-line react-hooks/refs
  selectedDatasetIdRef.current = selectedDatasetId;
  const selectDatasetRef = useRef(selectDataset);
  // eslint-disable-next-line react-hooks/refs
  selectDatasetRef.current = selectDataset;
  const toolRef = useRef(tool);
  // eslint-disable-next-line react-hooks/refs
  toolRef.current = tool;
  const myIdRef = useRef(myId);
  // eslint-disable-next-line react-hooks/refs
  myIdRef.current = myId;
  const sendCommandRef = useRef(sendCommand);
  // eslint-disable-next-line react-hooks/refs
  sendCommandRef.current = sendCommand;
  const onDocumentChangedRef = useRef(onDocumentChanged);
  // eslint-disable-next-line react-hooks/refs
  onDocumentChangedRef.current = onDocumentChanged;
  const onLongPressRef = useRef(onLongPress);
  // eslint-disable-next-line react-hooks/refs
  onLongPressRef.current = onLongPress;

  // Mirror the scene into a ref so the fly-camera input hook sees
  // the latest each frame. Mirror updates are render-phase
  // and idempotent — the canonical workaround for the new react-hooks/refs
  // strictness.
  const sceneRef = useRef<WasmScene>(scene);
  // eslint-disable-next-line react-hooks/refs
  sceneRef.current = scene;

  const isFlyMode = cameraMode === "fly";

  // The fly keys bind whenever the volume shows, so the shortcut sheet lists
  // them, and take precedence over global keys (L is also the line tool)
  // only in fly mode. Clipping works in either camera.
  // Keys steer the active view alone.
  const flyKeys = useHeldKeys(FLY_BINDINGS, { group: "Fly camera", scope: "fly", enabled: active });
  const clipKeys = useHeldKeys(CLIP_BINDINGS, { group: "View", enabled: active });
  useShortcutScope("fly", isFlyMode && active);
  const flyKeysRef = useRef(flyKeys);

  const toggleFly = () => {
    const currentMode = scene.camera_mode();
    if (currentMode === "fly") {
      applyViewportCommand(scene, { type: "set_mode_arcball" });
    } else if (currentMode === "arcball") {
      applyViewportCommand(scene, { type: "set_mode_fly" });
      const BASE_SPEED_FACTOR = 0.3;
      const diagonal = scene.volume_diagonal();
      scene.fly_set_base_speed(diagonal * BASE_SPEED_FACTOR);
    }
    if (scene.camera_mode() === "fly") setShowHint(true);
    breakFollow();
    emitPresence();
    loopRef.current?.markInteractiveDirty();
  };
  const canFly = useFineInputAvailable();
  useCommand({
    id: "camera.toggleFly",
    label: isFlyMode ? "Leave fly mode" : "Fly through the volume",
    group: "Fly camera",
    keys: TOGGLE_FLY_KEYS,
    keywords: ["camera", "orbit", "arcball"],
    run: toggleFly,
    // Steered by keys and a mouse, so offered only with one of them, or to
    // get back out.
    enabled: active && (canFly || isFlyMode),
  });

  // A fly-specific dirty source: fly ticks every frame, so attribution is useful
  // here, and the rate limiter collapses it to one log line per second.
  const fly = useFlyCameraInput(
    sceneRef,
    applyViewportCommand,
    flyKeysRef,
    isFlyMode && active,
    emitPresence,
    useCallback(() => loopRef.current?.markInteractiveDirty("fly_camera_input"), [loopRef]),
    useCallback(() => {
      clearTimeout(scaleTimerRef.current);
      loopRef.current?.setRenderScale(INTERACTION_RENDER_SCALE);
    }, [loopRef]),
    useCallback(() => {
      clearTimeout(scaleTimerRef.current);
      // scaleTimerRef is captured by useFlyCameraInput's callback chain;
      // .current writes here are deferred (timer body), not render-phase.
      // eslint-disable-next-line react-hooks/immutability
      scaleTimerRef.current = window.setTimeout(() => {
        loopRef.current?.setRenderScale(FULL_RENDER_SCALE);
      }, SCALE_RESTORE_DELAY_MS);
    }, [loopRef]),
  );

  // Held clip keys.
  useEffect(() => {
    let lastTime = 0;

    return frameClock.subscribe((time) => {
      const dt = lastTime > 0 ? Math.min((time - lastTime) / 1000, 0.1) : 0;
      lastTime = time;

      const farther = clipKeys.has("clipFarther");
      const nearer = clipKeys.has("clipNearer");
      if (farther === nearer) {
        // The next press starts from rest, not from the last frame before it.
        lastTime = 0;
        return false;
      }
      const delta = (farther ? 1 : -1) * CLIP_SPEED * (dt * 60); // normalize to ~60fps
      scene.adjust_clip_distance(delta);
      emitPresence();
      requestRender(loopRef.current, "clip_keys");
      // A held key moves the clip every frame without further input.
      return true;
    });
  }, [loopRef, scene, clipKeys, emitPresence]);

  // Resolution scaling during interaction
  const scaleTimerRef = useRef<number>(0);
  const setLowRes = useCallback(() => {
    clearTimeout(scaleTimerRef.current);
    loopRef.current?.setRenderScale(INTERACTION_RENDER_SCALE);
  }, [loopRef]);
  const scheduleFullRes = useCallback((delayMs: number = SCALE_RESTORE_DELAY_MS) => {
    clearTimeout(scaleTimerRef.current);
    // Same reasoning as the inline callback above: deferred write inside
    // a debounced callback, not a render-phase mutation.
    // eslint-disable-next-line react-hooks/immutability
    scaleTimerRef.current = window.setTimeout(() => {
      loopRef.current?.setRenderScale(FULL_RENDER_SCALE);
    }, delayMs);
  }, [loopRef]);
  useEffect(() => () => clearTimeout(scaleTimerRef.current), []);

  // Arcball input handling
  const [dragging, setDragging] = useState(false);
  const shiftDragRef = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  // A press that may become a point or a line/box draw. For a point, crossing
  // the click slop turns it into an orbit, or a pan with shift; for a shape,
  // the drag draws (no camera move) and the shape is emitted on release.
  // `endEscape` drops the press's Escape layer.
  const pinPressRef = useRef<{
    x: number;
    y: number;
    moved: boolean;
    kind: AnnotationKind;
    endEscape: () => void;
  } | null>(null);

  // Escape mid-press abandons it: no annotation lands on release, and the
  // rest of the drag leaves the camera alone.
  const cancelPress = useCallback(() => {
    pinPressRef.current?.endEscape();
    pinPressRef.current = null;
    annotationDraftRef.current = null;
    setDragging(false);
  }, [annotationDraftRef]);

  /** Where a client point's ray meets `datasetId`'s volume in this view, as
   * a frame point, or `null` if the ray missed. */
  const pickVoxel = useCallback(
    (datasetId: string, clientX: number, clientY: number) => pickFramePoint(scene, surface, datasetId, { clientX, clientY }),
    [scene, surface],
  );

  /** Draw an annotation from a shift gesture. A line/box depth-picks both
   * endpoints and stores the second as `end`. It lands on the layer whose
   * volume the anchor's ray meets ({@link annotationTarget}), and declines when
   * a ray misses, so an annotation always anchors to data. Picks use the same
   * frame as a 2D draw, so the shape renders in both views. The shared `z` is
   * the anchor vertex's depth. */
  const drawAnnotation = useCallback(
    (startX: number, startY: number, endX: number, endY: number, kind: "point" | "line" | "box") => {
      const shape = kind === "line" || kind === "box";
      const [anchorX, anchorY] = shape ? [startX, startY] : [endX, endY];
      const datasetId = annotationTarget(scene, surface, { clientX: anchorX, clientY: anchorY }, selectedDatasetIdRef.current);
      if (!datasetId) {
        sayNoLayerToAnnotate();
        return;
      }
      const anchor = pickVoxel(datasetId, anchorX, anchorY);
      if (!anchor) return; // anchor ray missed → don't draw
      const z = anchor[2];
      let end: [number, number] | null = null;
      if (shape) {
        const far = pickVoxel(datasetId, endX, endY);
        if (!far) return; // far ray missed → decline rather than draw a half shape
        end = [far[0], far[1]];
      }
      const id = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      // Snapshot the author's view onto the pin so navigation can restore it.
      // A null capture just omits the view.
      const capturedView = buildAnnotationView(scene);
      // Apply locally and send: the server's rebroadcast excludes the sender, so
      // the local apply is what shows the author their shape. The client-supplied
      // id makes the local and peer copies converge.
      applyDocumentCommand(
        scene,
        {
          type: "add_annotation",
          dataset_id: datasetId,
          id,
          position: [anchor[0], anchor[1]],
          end,
          z,
          // In 3D `z` is the picked depth, while T is the view's selector.
          t: scene.t(),
          c: shownChannels(readResolvedLayers(scene, surface.view).get(datasetId))[0],
          author: String(myIdRef.current),
          kind: shape ? kind : "point",
          ...(capturedView ? { view: capturedView } : {}),
        },
        sendCommandRef.current,
        loopRef.current,
      );
      onDocumentChangedRef.current();
      selectDatasetRef.current(datasetId);
    },
    [loopRef, scene, surface, pickVoxel],
  );

  // A press, from a mouse, a pen, or a finger drawing with a tool. Touch
  // navigation goes through the gesture recognizer instead, so the arcball
  // pointer handlers skip touch.
  const beginArcballPress = useCallback(
    (e: ClientPoint, shiftKey: boolean) => {
      setDragging(true);
      shiftDragRef.current = shiftKey;
      pinPressRef.current?.endEscape();
      const kind = pressAnnotationKind(toolRef.current, shiftKey);
      pinPressRef.current = kind
        ? { x: e.clientX, y: e.clientY, moved: false, kind, endEscape: pushEscapeLayer(cancelPress) }
        : null;
      lastPos.current = { x: e.clientX, y: e.clientY };
    },
    [cancelPress],
  );

  const onArcballPointerDown = useCallback(
    (e: PointerEvent) => {
      // The right button opens the view's menu instead.
      if (e.pointerType === "touch" || e.button === 2) return;
      beginArcballPress(e, e.shiftKey);
      element.setPointerCapture(e.pointerId);
      setLowRes();
    },
    [element, setLowRes, beginArcballPress],
  );

  const moveArcballPress = useCallback(
    (e: ClientPoint, atMs?: number) => {
      // Always broadcast cursor as normalized screen coordinates
      const rect = element.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / element.clientWidth;
      const ny = (e.clientY - rect.top) / element.clientHeight;
      sendCursor([nx, ny]);

      if (!dragging) return;

      const press = pinPressRef.current;
      // A line/box draw owns the whole drag: track that it moved (so release
      // knows it's a real two-vertex shape) but never pan/rotate the camera.
      if (press && isShapeKind(press.kind)) {
        if (exceedsClickSlop(press.x, press.y, e.clientX, e.clientY)) {
          press.moved = true;
        }
        // Live draw preview in view-relative CSS px. The camera holds still
        // during a draw, so raw screen coords match where the shape lands.
        annotationDraftRef.current = press.moved
          ? { kind: press.kind, x0: press.x - rect.left, y0: press.y - rect.top, x1: e.clientX - rect.left, y1: e.clientY - rect.top }
          : null;
        return;
      }

      // Within the click slop, hold off moving the camera so a tiny jitter
      // still resolves to a point on release. Past it, the press navigates.
      if (press && !press.moved) {
        if (!exceedsClickSlop(press.x, press.y, e.clientX, e.clientY)) {
          return;
        }
        press.moved = true;
        press.endEscape();
        lastPos.current = { x: e.clientX, y: e.clientY };
      }

      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      lastPos.current = { x: e.clientX, y: e.clientY };

      breakFollow();
      if (shiftDragRef.current) {
        applyViewportCommand(scene, { type: "arcball_pan", dx, dy });
      } else {
        const dTheta = -dx * ORBIT_RADIANS_PER_PIXEL;
        const dPhi = -dy * ORBIT_RADIANS_PER_PIXEL;
        applyViewportCommand(scene, { type: "arcball_rotate", d_theta: dTheta, d_phi: dPhi });
      }
      emitPresence();
      loopRef.current?.markInput(shiftDragRef.current ? "pan" : "orbit", atMs);
    },
    [loopRef, dragging, scene, element, emitPresence, breakFollow, sendCursor, annotationDraftRef],
  );

  const onArcballPointerMove = useCallback(
    (e: PointerEvent) => {
      if (e.pointerType !== "touch") moveArcballPress(e, e.timeStamp);
    },
    [moveArcballPress],
  );

  const endArcballPress = useCallback(
    (e: ClientPoint) => {
      setDragging(false);
      scheduleFullRes();
      const press = pinPressRef.current;
      pinPressRef.current = null;
      press?.endEscape();
      annotationDraftRef.current = null; // draw ended; committed shape takes over
      if (!press) return;
      if (isShapeKind(press.kind) && press.moved) {
        // A dragged line/box: draw from the press anchor to the release point.
        drawAnnotation(press.x, press.y, e.clientX, e.clientY, press.kind);
      } else if (!press.moved) {
        // A click (point kind, or a shape that never dragged) drops a point.
        drawAnnotation(e.clientX, e.clientY, e.clientX, e.clientY, "point");
      }
      // A point press that navigated draws nothing.
    },
    [scheduleFullRes, drawAnnotation, annotationDraftRef],
  );

  const onArcballPointerUp = useCallback(
    (e: PointerEvent) => {
      if (e.pointerType !== "touch") endArcballPress(e);
    },
    [endArcballPress],
  );

  // Fly input handling
  const onFlyPointerDown = useCallback(
    (e: PointerEvent) => {
      element.setPointerCapture(e.pointerId);
      fly.onPointerDown(e);
    },
    [element, fly],
  );

  const onFlyPointerMove = useCallback(
    (e: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / element.clientWidth;
      const ny = (e.clientY - rect.top) / element.clientHeight;
      sendCursor([nx, ny]);

      fly.onPointerMove(e);
    },
    [element, sendCursor, fly],
  );

  const onFlyPointerUp = useCallback(
    (e: PointerEvent) => {
      fly.onPointerUp();
      void e;
    },
    [fly],
  );

  const onPointerLeave = useCallback(() => {
    sendCursor(null);
  }, [sendCursor]);

  // A cancelled gesture must never drop a pin (or leave a half-finished drag).
  const onPointerCancel = useCallback((e: PointerEvent) => {
    if (e.pointerType === "touch" && !isFlyMode) return;
    cancelPress();
    setDragging(false);
    scheduleFullRes();
    if (isFlyMode) fly.onPointerUp();
  }, [cancelPress, scheduleFullRes, isFlyMode, fly]);

  /** Move the camera from a touch gesture, at the interaction render scale the
   * wheel uses. */
  const navigate = (input: "orbit" | "pan" | "zoom", move: () => void) => {
    breakFollow();
    move();
    emitPresence();
    loopRef.current?.markInput(input);
    setLowRes();
    scheduleFullRes(GESTURE_RESTORE_DELAY_MS);
  };

  const sendTouchCursor = (g: { x: number; y: number }) => {
    const rect = element.getBoundingClientRect();
    sendCursor([(g.x - rect.left) / element.clientWidth, (g.y - rect.top) / element.clientHeight]);
  };

  // One finger orbits, or draws with a tool; two pinch to zoom and drag to
  // pan. Fly mode keeps its own pointer handling, touch included.
  useTouchGestures(element, !isFlyMode, {
    claimsPress: () => drawsOnPress(toolRef.current),
    onGesture: (g) => {
      switch (g.type) {
        case "pressStart":
          beginArcballPress(clientPoint(g), false);
          setLowRes();
          break;
        case "pressMove":
          moveArcballPress(clientPoint(g));
          break;
        case "pressEnd":
          endArcballPress(clientPoint(g));
          break;
        case "pressCancel":
          cancelPress();
          scheduleFullRes();
          break;
        case "drag":
          navigate("orbit", () =>
            applyViewportCommand(scene, {
              type: "arcball_rotate",
              d_theta: -g.dx * ORBIT_RADIANS_PER_PIXEL,
              d_phi: -g.dy * ORBIT_RADIANS_PER_PIXEL,
            }),
          );
          sendTouchCursor(g);
          break;
        case "pinch":
          navigate(g.scale === 1 ? "pan" : "zoom", () => {
            // Spreading the fingers brings the camera closer by the same ratio.
            if (g.scale !== 1) applyViewportCommand(scene, { type: "arcball_zoom", delta: 1 / g.scale - 1 });
            if (g.dx !== 0 || g.dy !== 0) applyViewportCommand(scene, { type: "arcball_pan", dx: g.dx, dy: g.dy });
          });
          sendTouchCursor(g);
          break;
        case "doubleTap":
          navigate("zoom", () => frameOnCanvas(scene, canvas));
          break;
        case "longPress":
          onLongPressRef.current?.(clientPoint(g));
          break;
      }
    },
  });

  // Clear cursor on unmount (e.g. mode switch to 2D)
  useEffect(() => {
    return () => { sendCursor(null); };
  }, [sendCursor]);

  const onArcballWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const factor = wheelZoom(e);
      if (factor === 1) return;
      breakFollow();
      // The camera comes in by the factor, so what it shows grows by it, as a slice view's does.
      applyViewportCommand(scene, { type: "arcball_zoom", delta: 1 / factor - 1 });
      emitPresence();
      loopRef.current?.markInput("zoom", e.timeStamp);
      setLowRes();
      scheduleFullRes(GESTURE_RESTORE_DELAY_MS);
    },
    [loopRef, scene, emitPresence, breakFollow, setLowRes, scheduleFullRes],
  );

  const onFlyWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      // The wheel scales the speed by the factor it zooms by elsewhere, up faster.
      scene.fly_adjust_speed(wheelZoom(e));
    },
    [scene],
  );

  const onWheel = isFlyMode ? onFlyWheel : onArcballWheel;

  const onPointerDown = isFlyMode ? onFlyPointerDown : onArcballPointerDown;
  const onPointerMove = isFlyMode ? onFlyPointerMove : onArcballPointerMove;
  const onPointerUp = isFlyMode ? onFlyPointerUp : onArcballPointerUp;

  useEffect(() => {
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", onPointerUp);
    element.addEventListener("pointercancel", onPointerCancel);
    element.addEventListener("pointerleave", onPointerLeave);
    element.addEventListener("wheel", onWheel, { passive: false });
    // Same cursor-mutation pattern as SliceViewer: lightweight DOM mutation
    // for hover/drag feedback, vs a parent-driven CSS class that would
    // re-render the whole viewport on every transition.
    // eslint-disable-next-line react-hooks/immutability
    element.style.cursor = isFlyMode || drawsOnPress(tool) ? "crosshair" : (dragging ? "grabbing" : "grab");
    return () => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerCancel);
      element.removeEventListener("pointerleave", onPointerLeave);
      element.removeEventListener("wheel", onWheel);
    };
  }, [element, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave, onWheel, dragging, isFlyMode, tool]);

  const dismissHint = useCallback(() => setShowHint(false), []);

  return (
    <FlyCameraHint visible={isFlyMode && showHint} onDismiss={dismissHint} />
  );
}

// Memoized so a viewer render that changes none of its props, such as one
// for a peer's message, skips it; its props are stable for that reason.
export const VolumeViewer = memo(VolumeViewerBody);
