/** 3D volume viewer — delegates WebGPU rendering to a worker via RenderClient. */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { RenderClient } from "../renderer/renderClient.ts";
import { RenderLoop, type DatasetEntry } from "../renderLoop.ts";
import type { Session } from "../session.ts";
import { applyDocumentCommand, applyViewportCommand } from "../applyAndSend.ts";
import { useKeyState } from "../hooks/useKeyState.ts";
import { getBoundKeys, isActionPressed } from "../config/keyBindings.ts";
import { useFlyCameraInput } from "../hooks/useFlyCameraInput.ts";
import { FlyCameraHint } from "./FlyCameraHint.tsx";

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
  /** Shape a shift-drag draws: a point pin, a line, or a box. */
  annotationKind: "point" | "line" | "box";
  /** Local client id, recorded as the pin's author. */
  myId: number;
  /** Send a wire command (already wrapped by the bridge). */
  sendCommand: (json: string) => void;
  /** Notify the parent that the document changed locally (a pin was dropped). */
  onDocumentChanged: () => void;
}

/** Max pointer travel (CSS px) for a shift press+release to count as a pin
 * drop rather than a shift-pan drag. Mirrors SliceViewer's PIN_CLICK_SLOP. */
const PIN_CLICK_SLOP = 4;

const CLIP_SPEED = 0.02; // world-space units per frame at 60 fps
const INTERACTION_RENDER_SCALE = 0.5;
const FULL_RENDER_SCALE = 1.0;
const SCALE_RESTORE_DELAY_MS = 50;

export function VolumeViewer({ session, scene, datasets, client, canvas, remoteDocumentVersion, emitPresence, breakFollow, sendCursor, t, c, loopRef: parentLoopRef, onLoopChange, onCameraModeChange, annotationDatasetId, annotationKind, myId, sendCommand, onDocumentChanged }: Props) {
  const loopRef = useRef<RenderLoop | null>(null);
  const [cameraMode, setCameraMode] = useState<string>(() => scene.camera_mode());
  const [showHint, setShowHint] = useState(false);

  // Mirror pin-drop props into refs so the pointer handlers (bound on `canvas`)
  // read the latest values without re-binding on every doc change — the same
  // pattern SliceViewer uses for its pin-drop path.
  const annotationDatasetIdRef = useRef(annotationDatasetId);
  // eslint-disable-next-line react-hooks/refs
  annotationDatasetIdRef.current = annotationDatasetId;
  const annotationKindRef = useRef(annotationKind);
  // eslint-disable-next-line react-hooks/refs
  annotationKindRef.current = annotationKind;
  const myIdRef = useRef(myId);
  // eslint-disable-next-line react-hooks/refs
  myIdRef.current = myId;
  const sendCommandRef = useRef(sendCommand);
  // eslint-disable-next-line react-hooks/refs
  sendCommandRef.current = sendCommand;
  const onDocumentChangedRef = useRef(onDocumentChanged);
  // eslint-disable-next-line react-hooks/refs
  onDocumentChangedRef.current = onDocumentChanged;

  // Notify parent of camera mode (after render, to avoid setState-in-render)
  useEffect(() => {
    onCameraModeChange?.(cameraMode);
  }, [cameraMode, onCameraModeChange]);

  // Mirror props into refs so the RAF tick + fly-camera input hook see
  // the latest canvas/scene each frame. Mirror updates are render-phase
  // and idempotent — the canonical workaround for the new react-hooks/refs
  // strictness.
  const canvasRef = useRef<HTMLCanvasElement>(canvas);
  // eslint-disable-next-line react-hooks/refs
  canvasRef.current = canvas;
  const boundKeys = useMemo(() => getBoundKeys(), []);
  const pressedKeys = useKeyState(canvasRef, boundKeys);

  // Stable refs for callbacks needed by useFlyCameraInput
  const sceneRef = useRef<WasmScene>(scene);
  // eslint-disable-next-line react-hooks/refs
  sceneRef.current = scene;

  const isFlyMode = cameraMode === "fly";

  // Inline the markInteractiveDirty wrapper here (instead of reusing the
  // shared `markInteractiveDirty` above) so the dirty_set log carries a
  // fly-specific source. Fly-camera ticks every animation frame, so this
  // is the one external caller where attribution is genuinely useful;
  // the rate-limiter collapses 60+/sec into one log line per second.
  const fly = useFlyCameraInput(
    sceneRef,
    applyViewportCommand,
    { current: pressedKeys },
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

  // Clip distance adjustment + fly mode toggle via RAF loop
  useEffect(() => {
    let rafId: number | null = null;
    let lastTime = 0;
    let fWasPressed = false;

    function tick(time: number) {
      const dt = lastTime > 0 ? Math.min((time - lastTime) / 1000, 0.1) : 0;
      lastTime = time;

      // Clip distance
      const inc = isActionPressed(pressedKeys, "clip.increase");
      const dec = isActionPressed(pressedKeys, "clip.decrease");
      if (inc || dec) {
        const delta = (inc ? 1 : -1) * CLIP_SPEED * (dt * 60); // normalize to ~60fps
        scene.adjust_clip_distance(delta);
        emitPresence();
        loopRef.current?.markInteractiveDirty();
      }

      // Toggle fly mode on F key press (edge detect)
      const fPressed = isActionPressed(pressedKeys, "camera.toggleFly");
      if (fPressed && !fWasPressed) {
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
        onCameraModeChange?.(newMode);
        if (newMode === "fly") setShowHint(true);
        breakFollow();
        emitPresence();
        loopRef.current?.markInteractiveDirty();
        canvas.focus();
      }
      fWasPressed = fPressed;

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [scene, pressedKeys, emitPresence, breakFollow, canvas]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Context for a shift press that may become a pin drop or a line/box draw:
  // where it started, whether it has since moved past the click slop, and
  // whether it is drawing a shape (kind line/box). For a point, crossing the
  // slop turns it into a shift-pan exactly as before; for a shape, the drag
  // draws (no pan) and the shape is emitted on release.
  const pinPressRef = useRef<{ x: number; y: number; moved: boolean; shape: boolean } | null>(null);

  /** Ray-cast a client point into the volume, returning its in-plane-voxel +
   * voxel-depth point `[x, y, z]`, or `null` if the ray missed. The same depth
   * pick a pin drop uses, factored out so a line/box can pick both endpoints. */
  const pickVoxel = useCallback(
    (clientX: number, clientY: number): [number, number, number] | null => {
      const datasetId = annotationDatasetIdRef.current;
      if (!datasetId) return null;
      const dpr = devicePixelRatio;
      const rect = canvas.getBoundingClientRect();
      // pick_annotation_voxel takes physical-pixel screen coords (the same space
      // the WASM viewport uses), matching project_to_screen.
      const screenX = (clientX - rect.left) * dpr;
      const screenY = (clientY - rect.top) * dpr;
      const voxel = scene.pick_annotation_voxel(datasetId, screenX, screenY);
      return voxel.length < 3 ? null : [voxel[0], voxel[1], voxel[2]];
    },
    [canvas, scene],
  );

  /** Draw an annotation from a shift gesture. A point is a single depth-picked
   * drop (drop-where-clicked); a line/box depth-picks both endpoints and stores
   * the second as `end`. No-op (declines) when no dataset is selected or a
   * required ray misses the volume — an annotation should anchor to data, never
   * float in empty space. The picks are stored as in-plane voxel position +
   * voxel depth (z), the same frame a 2D draw uses, so the shape round-trips and
   * renders in both views. The shared `z` is the anchor vertex's depth. */
  const drawAnnotation = useCallback(
    (startX: number, startY: number, endX: number, endY: number, kind: "point" | "line" | "box") => {
      const datasetId = annotationDatasetIdRef.current;
      if (!datasetId) return;
      const shape = kind === "line" || kind === "box";
      const anchor = pickVoxel(shape ? startX : endX, shape ? startY : endY);
      if (!anchor) return; // anchor ray missed → don't draw
      let end: [number, number] | null = null;
      if (shape) {
        const far = pickVoxel(endX, endY);
        if (!far) return; // far ray missed → decline rather than draw a half shape
        end = [far[0], far[1]];
      }
      const id = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      // Apply locally AND send (mirrors SliceViewer's draw and every other doc
      // command): the sender is excluded from the server's rebroadcast, so the
      // local apply is what shows the author their own shape. The client-supplied
      // id makes the local apply and the peers' broadcast converge.
      applyDocumentCommand(
        scene,
        {
          type: "add_annotation",
          dataset_id: datasetId,
          id,
          position: [anchor[0], anchor[1]],
          end,
          z: anchor[2],
          author: String(myIdRef.current),
          kind: shape ? kind : "point",
        },
        sendCommandRef.current,
      );
      onDocumentChangedRef.current();
      loopRef.current?.markInteractiveDirty();
    },
    [scene, pickVoxel],
  );

  const onArcballPointerDown = useCallback(
    (e: PointerEvent) => {
      setDragging(true);
      shiftDragRef.current = e.shiftKey;
      // A shift press starts a candidate annotation. With kind=point it becomes
      // a shift-pan if it moves past the slop; with kind=line/box the drag
      // draws the shape (and never pans).
      const kind = annotationKindRef.current;
      pinPressRef.current = e.shiftKey
        ? { x: e.clientX, y: e.clientY, moved: false, shape: kind === "line" || kind === "box" }
        : null;
      lastPos.current = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      setLowRes();
    },
    [canvas, setLowRes],
  );

  const onArcballPointerMove = useCallback(
    (e: PointerEvent) => {
      // Always broadcast cursor as normalized screen coordinates
      const rect = canvas.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / canvas.clientWidth;
      const ny = (e.clientY - rect.top) / canvas.clientHeight;
      sendCursor([nx, ny]);

      if (!dragging) return;

      const press = pinPressRef.current;
      // A line/box draw owns the whole drag: track that it moved (so release
      // knows it's a real two-vertex shape) but never pan/rotate the camera.
      if (press?.shape) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > PIN_CLICK_SLOP) {
          press.moved = true;
        }
        return;
      }

      // While a shift press is still within the click slop, hold off panning so
      // a tiny jitter still resolves to a pin drop on release. Once it crosses
      // the slop it's a deliberate shift-pan — mark it moved and pan as before.
      if (press && !press.moved) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= PIN_CLICK_SLOP) {
          return;
        }
        press.moved = true;
        lastPos.current = { x: e.clientX, y: e.clientY };
      }

      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      lastPos.current = { x: e.clientX, y: e.clientY };

      breakFollow();
      if (shiftDragRef.current) {
        applyViewportCommand(scene, { type: "arcball_pan", dx, dy });
      } else {
        const dTheta = -dx * 0.005;
        const dPhi = -dy * 0.005;
        applyViewportCommand(scene, { type: "arcball_rotate", d_theta: dTheta, d_phi: dPhi });
      }
      emitPresence();
      loopRef.current?.markInteractiveDirty();
    },
    [dragging, scene, canvas, emitPresence, breakFollow, sendCursor],
  );

  const onArcballPointerUp = useCallback(
    (e: PointerEvent) => {
      setDragging(false);
      scheduleFullRes();
      const press = pinPressRef.current;
      pinPressRef.current = null;
      if (!press) return;
      if (press.shape && press.moved) {
        // A dragged line/box: draw from the press anchor to the release point.
        drawAnnotation(press.x, press.y, e.clientX, e.clientY, annotationKindRef.current);
      } else if (!press.moved) {
        // A click (point kind, or a shape that never dragged) drops a point.
        drawAnnotation(e.clientX, e.clientY, e.clientX, e.clientY, "point");
      }
      // A point-kind shift-pan (moved, not a shape) draws nothing — unchanged.
    },
    [scheduleFullRes, drawAnnotation],
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
  const onPointerCancel = useCallback(() => {
    pinPressRef.current = null;
    setDragging(false);
    scheduleFullRes();
    if (isFlyMode) fly.onPointerUp();
  }, [scheduleFullRes, isFlyMode, fly]);

  // Clear cursor on unmount (e.g. mode switch to 2D)
  useEffect(() => {
    return () => { sendCursor(null); };
  }, [sendCursor]);

  const onArcballWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY * 0.001;
      breakFollow();
      applyViewportCommand(scene, { type: "arcball_zoom", delta });
      emitPresence();
      loopRef.current?.markInteractiveDirty();
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
    canvas.style.cursor = isFlyMode ? "crosshair" : (dragging ? "grabbing" : "grab");
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [canvas, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave, onWheel, dragging, isFlyMode]);

  const dismissHint = useCallback(() => setShowHint(false), []);

  return (
    <FlyCameraHint visible={isFlyMode && showHint} onDismiss={dismissHint} />
  );
}
