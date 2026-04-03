/** 3D volume viewer — delegates WebGPU rendering to a worker via RenderClient. */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { WasmScene } from "lucida-core";
import { RenderClient } from "../renderer/renderClient.ts";
import { RenderLoop, type DatasetEntry } from "../renderLoop.ts";
import { applyViewportCommand } from "../applyAndSend.ts";
import { useKeyState } from "../hooks/useKeyState.ts";
import { getBoundKeys, isActionPressed } from "../config/keyBindings.ts";
import { useFlyCameraInput } from "../hooks/useFlyCameraInput.ts";
import { FlyCameraHint } from "./FlyCameraHint.tsx";

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
  onCameraModeChange?: (mode: string) => void;
}

const CLIP_SPEED = 0.02; // world-space units per frame at 60 fps
const INTERACTION_RENDER_SCALE = 0.5;
const FULL_RENDER_SCALE = 1.0;
const SCALE_RESTORE_DELAY_MS = 50;

export function VolumeViewer({ scene, datasets, client, canvas, remoteDocumentVersion, emitPresence, breakFollow, sendCursor, t, c, loopRef: parentLoopRef, onLoopChange, onCameraModeChange }: Props) {
  const loopRef = useRef<RenderLoop | null>(null);
  const [cameraMode, setCameraMode] = useState<string>(() => scene.camera_mode());
  const [showHint, setShowHint] = useState(false);

  // Notify parent of camera mode (after render, to avoid setState-in-render)
  useEffect(() => {
    onCameraModeChange?.(cameraMode);
  }, [cameraMode, onCameraModeChange]);

  // Key state for clip distance adjustment and fly camera
  const canvasRef = useRef<HTMLCanvasElement>(canvas);
  canvasRef.current = canvas;
  const boundKeys = useMemo(() => getBoundKeys(), []);
  const pressedKeys = useKeyState(canvasRef, boundKeys);

  // Stable refs for callbacks needed by useFlyCameraInput
  const sceneRef = useRef<WasmScene>(scene);
  sceneRef.current = scene;

  const markViewDirty = useCallback(() => {
    loopRef.current?.markViewDirty();
  }, []);

  const isFlyMode = cameraMode === "fly";

  // Fly camera input hook
  const fly = useFlyCameraInput(
    sceneRef,
    applyViewportCommand,
    { current: pressedKeys },
    isFlyMode,
    emitPresence,
    markViewDirty,
    useCallback(() => {
      clearTimeout(scaleTimerRef.current);
      loopRef.current?.setRenderScale(INTERACTION_RENDER_SCALE);
    }, []),
    useCallback(() => {
      clearTimeout(scaleTimerRef.current);
      scaleTimerRef.current = window.setTimeout(() => {
        loopRef.current?.setRenderScale(FULL_RENDER_SCALE);
      }, SCALE_RESTORE_DELAY_MS);
    }, []),
  );

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
    loopRef.current?.markViewDirty();
  }, [remoteDocumentVersion]);

  // Mark dirty on T/C changes so the render loop re-evaluates chunks
  useEffect(() => {
    loopRef.current?.markViewDirty();
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
        loopRef.current?.markViewDirty();
      }

      // Toggle fly mode on F key press (edge detect)
      const fPressed = isActionPressed(pressedKeys, "camera.toggleFly");
      if (fPressed && !fWasPressed) {
        const currentMode = scene.camera_mode();
        if (currentMode === "fly") {
          // Switch back to arcball
          scene.set_mode_arcball();
        } else if (currentMode === "arcball") {
          // Switch to fly, then set base speed from volume diagonal
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
        loopRef.current?.markViewDirty();
        canvas.focus();
      }
      fWasPressed = fPressed;

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [scene, pressedKeys, emitPresence, breakFollow, canvas]);

  // Resolution scaling during interaction
  const scaleTimerRef = useRef<number>(0);
  const setLowRes = useCallback(() => {
    clearTimeout(scaleTimerRef.current);
    loopRef.current?.setRenderScale(INTERACTION_RENDER_SCALE);
  }, []);
  const scheduleFullRes = useCallback(() => {
    clearTimeout(scaleTimerRef.current);
    scaleTimerRef.current = window.setTimeout(() => {
      loopRef.current?.setRenderScale(FULL_RENDER_SCALE);
    }, SCALE_RESTORE_DELAY_MS);
  }, []);
  useEffect(() => () => clearTimeout(scaleTimerRef.current), []);

  // --- Arcball input handling ---
  const [dragging, setDragging] = useState(false);
  const shiftDragRef = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const onArcballPointerDown = useCallback(
    (e: PointerEvent) => {
      setDragging(true);
      shiftDragRef.current = e.shiftKey;
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
      loopRef.current?.markViewDirty();
    },
    [dragging, scene, canvas, emitPresence, breakFollow, sendCursor],
  );

  const onArcballPointerUp = useCallback(() => {
    setDragging(false);
    scheduleFullRes();
  }, [scheduleFullRes]);

  // --- Fly input handling ---
  const onFlyPointerDown = useCallback(
    (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      fly.onPointerDown(e);
    },
    [canvas, fly],
  );

  const onFlyPointerMove = useCallback(
    (e: PointerEvent) => {
      // Broadcast cursor
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
      loopRef.current?.markViewDirty();
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

  // Select handler set based on camera mode
  const onPointerDown = isFlyMode ? onFlyPointerDown : onArcballPointerDown;
  const onPointerMove = isFlyMode ? onFlyPointerMove : onArcballPointerMove;
  const onPointerUp = isFlyMode ? onFlyPointerUp : onArcballPointerUp;

  // Attach event handlers to the shared canvas
  useEffect(() => {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.style.cursor = isFlyMode ? "crosshair" : (dragging ? "grabbing" : "grab");
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [canvas, onPointerDown, onPointerMove, onPointerUp, onPointerLeave, onWheel, dragging, isFlyMode]);

  const dismissHint = useCallback(() => setShowHint(false), []);

  return (
    <FlyCameraHint visible={isFlyMode && showHint} onDismiss={dismissHint} />
  );
}
