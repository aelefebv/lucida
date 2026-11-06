/** 3D volume viewer. WebGPU rendering runs in a worker via RenderClient. */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ORBIT_RADIANS_PER_PIXEL, VOLUME_ZOOM_PER_WHEEL_DELTA } from "./inputScale.ts";
import type { WasmScene } from "lucida-core";
import { RenderClient } from "../renderer/renderClient.ts";
import { RenderLoop, type DatasetEntry } from "../renderLoop.ts";
import type { Session } from "../session.ts";
import { applyDocumentCommand, applyViewportCommand } from "../applyAndSend.ts";
import { buildAnnotationView, liveViewWithLiveTC } from "../savedView/buildAnnotationView.ts";
import { useHeldKeys } from "../hooks/useHeldKeys.ts";
import { CLIP_BINDINGS, FLY_BINDINGS, TOGGLE_FLY_KEYS } from "../config/keyBindings.ts";
import { useFlyCameraInput } from "../hooks/useFlyCameraInput.ts";
import { useFineInputAvailable } from "../input/pointerCapabilities.ts";
import { useCommand } from "../ui/commands.ts";
import { pushEscapeLayer } from "../ui/escape.ts";
import { useShortcutScope } from "../ui/shortcuts.ts";
import { FlyCameraHint } from "./FlyCameraHint.tsx";
import type { AnnotationDraft } from "./annotationDraft.ts";
import { exceedsClickSlop } from "./annotationInteraction.ts";
import { isShapeKind, pressAnnotationKind, type AnnotationKind, type Tool } from "./annotationTool.ts";
import { eventToScreenPx, type ClientPoint } from "./cameraProjection.ts";
import { clientPoint, useTouchGestures } from "../input/useTouchGestures.ts";

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
  t: number;
  c: number;
  loopRef: RefObject<RenderLoop | null>;
  onLoopChange: (loop: RenderLoop | null) => void;
  onCameraModeChange?: (mode: string) => void;
  /** Dataset to attach a dropped pin to (annotations are scoped per dataset). */
  annotationDatasetId: string | null;
  /** The canvas tool: pan, or the annotation shape a press draws. */
  tool: Tool;
  /** Stable, browser-persisted annotation-author identity, recorded as a 3D pin's
   * `author`. From `annotationAuthorId()`, not the per-connection `bridge.myId`,
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
const INTERACTION_RENDER_SCALE = 0.5;
const FULL_RENDER_SCALE = 1.0;
const SCALE_RESTORE_DELAY_MS = 50;

export function VolumeViewer({ session, scene, datasets, client, canvas, remoteDocumentVersion, emitPresence, breakFollow, sendCursor, t, c, loopRef: parentLoopRef, onLoopChange, onCameraModeChange, annotationDatasetId, tool, myId, sendCommand, onDocumentChanged, annotationDraftRef, onLongPress }: Props) {
  const loopRef = useRef<RenderLoop | null>(null);
  const [cameraMode, setCameraMode] = useState<string>(() => scene.camera_mode());
  const [showHint, setShowHint] = useState(false);

  // Mirror pin-drop props into refs so the canvas-bound pointer handlers read the
  // latest values without re-binding on every doc change.
  const annotationDatasetIdRef = useRef(annotationDatasetId);
  // eslint-disable-next-line react-hooks/refs
  annotationDatasetIdRef.current = annotationDatasetId;
  const toolRef = useRef(tool);
  // eslint-disable-next-line react-hooks/refs
  toolRef.current = tool;
  const myIdRef = useRef(myId);
  // eslint-disable-next-line react-hooks/refs
  myIdRef.current = myId;
  // A 3D pin records the view's T/C alongside its picked depth.
  const tRef = useRef(t);
  // eslint-disable-next-line react-hooks/refs
  tRef.current = t;
  const cRef = useRef(c);
  // eslint-disable-next-line react-hooks/refs
  cRef.current = c;
  const sendCommandRef = useRef(sendCommand);
  // eslint-disable-next-line react-hooks/refs
  sendCommandRef.current = sendCommand;
  const onDocumentChangedRef = useRef(onDocumentChanged);
  // eslint-disable-next-line react-hooks/refs
  onDocumentChangedRef.current = onDocumentChanged;
  const onLongPressRef = useRef(onLongPress);
  // eslint-disable-next-line react-hooks/refs
  onLongPressRef.current = onLongPress;

  // Notify parent of camera mode (after render, to avoid setState-in-render)
  useEffect(() => {
    onCameraModeChange?.(cameraMode);
  }, [cameraMode, onCameraModeChange]);

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
  const flyKeys = useHeldKeys(FLY_BINDINGS, { group: "Fly camera", scope: "fly", enabled: true });
  const clipKeys = useHeldKeys(CLIP_BINDINGS, { group: "View", enabled: true });
  useShortcutScope("fly", isFlyMode);
  const flyKeysRef = useRef(flyKeys);

  const toggleFly = () => {
    const currentMode = scene.camera_mode();
    if (currentMode === "fly") {
      scene.set_mode_arcball();
    } else if (currentMode === "arcball") {
      scene.set_mode_fly();
      const BASE_SPEED_FACTOR = 0.3;
      const diagonal = scene.volume_diagonal();
      scene.fly_set_base_speed(diagonal * BASE_SPEED_FACTOR);
    }
    const newMode = scene.camera_mode();
    setCameraMode(newMode);
    if (newMode === "fly") setShowHint(true);
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
    enabled: canFly || isFlyMode,
  });

  // A fly-specific dirty source: fly ticks every frame, so attribution is useful
  // here, and the rate limiter collapses it to one log line per second.
  const fly = useFlyCameraInput(
    sceneRef,
    applyViewportCommand,
    flyKeysRef,
    isFlyMode,
    emitPresence,
    useCallback(() => loopRef.current?.markInteractiveDirty("fly_camera_input"), []),
    useCallback(() => {
      clearTimeout(scaleTimerRef.current);
      loopRef.current?.setRenderScale(INTERACTION_RENDER_SCALE);
    }, []),
    useCallback(() => {
      clearTimeout(scaleTimerRef.current);
      // scaleTimerRef is captured by useFlyCameraInput's callback chain;
      // .current writes here are deferred (timer body), not render-phase.
      // eslint-disable-next-line react-hooks/immutability
      scaleTimerRef.current = window.setTimeout(() => {
        loopRef.current?.setRenderScale(FULL_RENDER_SCALE);
      }, SCALE_RESTORE_DELAY_MS);
    }, []),
  );

  // Create/start render loop. Same intentional omission as SliceViewer:
  // `datasets` is a live mutable Map, onLoopChange is a stable parent
  // callback, parentLoopRef is a ref — re-creating the loop on those would
  // tear down GPU state every frame.
  useEffect(() => {
    const loop = new RenderLoop({ session, datasets, client, canvas, mode: "volume" });
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

  // Mark dirty on T/C changes so the render loop re-evaluates chunks
  useEffect(() => {
    loopRef.current?.markInteractiveDirty();
  }, [t, c]);

  // Held clip keys, and the camera mode followed from the scene, since a
  // control outside this viewer or a restored view can switch it too.
  useEffect(() => {
    let rafId: number | null = null;
    let lastTime = 0;

    function tick(time: number) {
      const dt = lastTime > 0 ? Math.min((time - lastTime) / 1000, 0.1) : 0;
      lastTime = time;

      const farther = clipKeys.has("clipFarther");
      const nearer = clipKeys.has("clipNearer");
      if (farther !== nearer) {
        const delta = (farther ? 1 : -1) * CLIP_SPEED * (dt * 60); // normalize to ~60fps
        scene.adjust_clip_distance(delta);
        emitPresence();
        loopRef.current?.markInteractiveDirty();
      }

      setCameraMode(scene.camera_mode());
      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [scene, clipKeys, emitPresence]);

  // Resolution scaling during interaction
  const scaleTimerRef = useRef<number>(0);
  const setLowRes = useCallback(() => {
    clearTimeout(scaleTimerRef.current);
    loopRef.current?.setRenderScale(INTERACTION_RENDER_SCALE);
  }, []);
  const scheduleFullRes = useCallback(() => {
    clearTimeout(scaleTimerRef.current);
    // Same reasoning as the inline callback above: deferred write inside
    // a debounced callback, not a render-phase mutation.
    // eslint-disable-next-line react-hooks/immutability
    scaleTimerRef.current = window.setTimeout(() => {
      loopRef.current?.setRenderScale(FULL_RENDER_SCALE);
    }, SCALE_RESTORE_DELAY_MS);
  }, []);
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

  /** Ray-cast a client point into the volume: `[x, y, z]` as in-plane voxel
   * position plus voxel depth, or `null` if the ray missed. */
  const pickVoxel = useCallback(
    (clientX: number, clientY: number): [number, number, number] | null => {
      const datasetId = annotationDatasetIdRef.current;
      if (!datasetId) return null;
      // pick_annotation_voxel takes physical-pixel screen coords (the same space
      // the WASM viewport uses), matching project_to_screen.
      const [screenX, screenY] = eventToScreenPx(canvas, { clientX, clientY });
      const voxel = scene.pick_annotation_voxel(datasetId, screenX, screenY);
      return voxel.length < 3 ? null : [voxel[0], voxel[1], voxel[2]];
    },
    [canvas, scene],
  );

  /** Draw an annotation from a shift gesture. A line/box depth-picks both
   * endpoints and stores the second as `end`. Declines when no dataset is
   * selected or a ray misses, so an annotation always anchors to data. Picks use
   * the same frame as a 2D draw, so the shape renders in both views. The shared
   * `z` is the anchor vertex's depth. */
  const drawAnnotation = useCallback(
    (startX: number, startY: number, endX: number, endY: number, kind: "point" | "line" | "box") => {
      const datasetId = annotationDatasetIdRef.current;
      if (!datasetId) return;
      const shape = kind === "line" || kind === "box";
      const anchor = pickVoxel(shape ? startX : endX, shape ? startY : endY);
      if (!anchor) return; // anchor ray missed → don't draw
      // The pick can return the far-face depth (339.999 for a 340-deep volume),
      // which rounds outside [0, depth-1], so the pin would never match a 2D
      // slice. Clamp so 2D navigation can reach it.
      const depth = scene.dataset_volume_shape(datasetId)[0];
      const z = depth > 0 ? Math.max(0, Math.min(anchor[2], depth - 1)) : anchor[2];
      let end: [number, number] | null = null;
      if (shape) {
        const far = pickVoxel(endX, endY);
        if (!far) return; // far ray missed → decline rather than draw a half shape
        end = [far[0], far[1]];
      }
      const id = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      // Snapshot the author's view onto the pin so navigation can restore it. T/C
      // come from the live refs so the view matches the pin's own t/c. A null
      // capture just omits the view.
      const capturedView = buildAnnotationView(scene, liveViewWithLiveTC(scene, tRef.current, cRef.current));
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
          // In 3D `z` is the picked depth, while T/C are the view's selectors.
          t: tRef.current,
          c: cRef.current,
          author: String(myIdRef.current),
          kind: shape ? kind : "point",
          ...(capturedView ? { view: capturedView } : {}),
        },
        sendCommandRef.current,
      );
      onDocumentChangedRef.current();
      loopRef.current?.markInteractiveDirty();
    },
    [scene, pickVoxel],
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
      // The right button opens the canvas menu instead.
      if (e.pointerType === "touch" || e.button === 2) return;
      beginArcballPress(e, e.shiftKey);
      canvas.setPointerCapture(e.pointerId);
      setLowRes();
    },
    [canvas, setLowRes, beginArcballPress],
  );

  const moveArcballPress = useCallback(
    (e: ClientPoint) => {
      // Always broadcast cursor as normalized screen coordinates
      const rect = canvas.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / canvas.clientWidth;
      const ny = (e.clientY - rect.top) / canvas.clientHeight;
      sendCursor([nx, ny]);

      if (!dragging) return;

      const press = pinPressRef.current;
      // A line/box draw owns the whole drag: track that it moved (so release
      // knows it's a real two-vertex shape) but never pan/rotate the camera.
      if (press && isShapeKind(press.kind)) {
        if (exceedsClickSlop(press.x, press.y, e.clientX, e.clientY)) {
          press.moved = true;
        }
        // Live draw preview in canvas-relative CSS px. The camera holds still
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
      loopRef.current?.markInput(shiftDragRef.current ? "pan" : "orbit");
    },
    [dragging, scene, canvas, emitPresence, breakFollow, sendCursor, annotationDraftRef],
  );

  const onArcballPointerMove = useCallback(
    (e: PointerEvent) => {
      if (e.pointerType !== "touch") moveArcballPress(e);
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
      canvas.setPointerCapture(e.pointerId);
      fly.onPointerDown(e);
    },
    [canvas, fly],
  );

  const onFlyPointerMove = useCallback(
    (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / canvas.clientWidth;
      const ny = (e.clientY - rect.top) / canvas.clientHeight;
      sendCursor([nx, ny]);

      fly.onPointerMove(e);
    },
    [canvas, sendCursor, fly],
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
    scheduleFullRes();
  };

  const sendTouchCursor = (g: { x: number; y: number }) => {
    const rect = canvas.getBoundingClientRect();
    sendCursor([(g.x - rect.left) / canvas.clientWidth, (g.y - rect.top) / canvas.clientHeight]);
  };

  // One finger orbits, or draws with a tool; two pinch to zoom and drag to
  // pan. Fly mode keeps its own pointer handling, touch included.
  useTouchGestures(canvas, !isFlyMode, {
    claimsPress: () => toolRef.current !== "pan",
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
        case "doubleTap": {
          const datasetId = annotationDatasetIdRef.current ?? datasets.keys().next().value;
          if (!datasetId) break;
          navigate("zoom", () => {
            try {
              scene.fit_camera_to_dataset_bounds(datasetId);
            } catch {
              // A dataset with nothing loaded yet has no bounds; the view stays.
            }
          });
          break;
        }
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
      const delta = e.deltaY * VOLUME_ZOOM_PER_WHEEL_DELTA;
      breakFollow();
      applyViewportCommand(scene, { type: "arcball_zoom", delta });
      emitPresence();
      loopRef.current?.markInput("zoom");
      setLowRes();
      scheduleFullRes();
    },
    [scene, emitPresence, breakFollow, setLowRes, scheduleFullRes],
  );

  const onFlyWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      // Scroll up (negative deltaY) = faster, scroll down = slower
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      scene.fly_adjust_speed(factor);
    },
    [scene],
  );

  const onWheel = isFlyMode ? onFlyWheel : onArcballWheel;

  const onPointerDown = isFlyMode ? onFlyPointerDown : onArcballPointerDown;
  const onPointerMove = isFlyMode ? onFlyPointerMove : onArcballPointerMove;
  const onPointerUp = isFlyMode ? onFlyPointerUp : onArcballPointerUp;

  useEffect(() => {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    // Same cursor-mutation pattern as SliceViewer: lightweight DOM mutation
    // for hover/drag feedback, vs a parent-driven CSS class that would
    // re-render the whole viewport on every transition.
    // eslint-disable-next-line react-hooks/immutability
    canvas.style.cursor = isFlyMode || tool !== "pan" ? "crosshair" : (dragging ? "grabbing" : "grab");
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [canvas, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave, onWheel, dragging, isFlyMode, tool]);

  const dismissHint = useCallback(() => setShowHint(false), []);

  return (
    <FlyCameraHint visible={isFlyMode && showHint} onDismiss={dismissHint} />
  );
}
