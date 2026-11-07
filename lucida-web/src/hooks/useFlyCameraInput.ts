import { useRef, useEffect, useCallback } from "react";
import type { WasmScene } from "lucida-core";
import type { HeldAction } from "../config/keyBindings.ts";
import type { ViewportCommand } from "../commands.ts";
import { frameClock } from "../frameClock.ts";

/**
 * Drives the fly camera from the frame clock: held keys for translation and
 * rotation, accumulated mouse delta for mouselook. Returns the pointer handlers
 * VolumeViewer spreads onto the canvas.
 */
export function useFlyCameraInput(
  sceneRef: React.RefObject<WasmScene | null>,
  applyViewportCommand: (scene: WasmScene, cmd: ViewportCommand) => void,
  pressedKeysRef: React.RefObject<ReadonlySet<HeldAction>>,
  isActive: boolean,
  emitPresence: () => void,
  markInteractiveDirty: () => void,
  setLowRes: () => void,
  scheduleFullRes: () => void,
) {
  const mouseDeltaRef = useRef({ dx: 0, dy: 0 });
  const draggingRef = useRef(false);
  const lastTimeRef = useRef(0);
  const hadInputRef = useRef(false);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    lastTimeRef.current = performance.now();

    function tick(): boolean {
      const scene = sceneRef.current;
      const pressed = pressedKeysRef.current;
      if (!scene) return false;

      const now = performance.now();
      // The clock stops while nothing moves, so the gap before the first
      // frame of a new press can be seconds; that frame steps by one frame.
      const elapsed = (now - lastTimeRef.current) / 1000;
      const dt = hadInputRef.current ? Math.min(elapsed, 0.1) : Math.min(elapsed, 1 / 60);
      lastTimeRef.current = now;

      let forward = 0;
      let right = 0;
      let up = 0;
      if (pressed.has("forward")) forward += 1;
      if (pressed.has("backward")) forward -= 1;
      if (pressed.has("right")) right += 1;
      if (pressed.has("left")) right -= 1;
      if (pressed.has("up")) up += 1;
      if (pressed.has("down")) up -= 1;

      const ROTATION_SPEED = Math.PI / 4;
      let yaw = 0;
      let pitch = 0;
      let roll = 0;
      if (pressed.has("yawLeft")) yaw += ROTATION_SPEED;
      if (pressed.has("yawRight")) yaw -= ROTATION_SPEED;
      if (pressed.has("pitchUp")) pitch += ROTATION_SPEED;
      if (pressed.has("pitchDown")) pitch -= ROTATION_SPEED;
      if (pressed.has("rollLeft")) roll += ROTATION_SPEED;
      if (pressed.has("rollRight")) roll -= ROTATION_SPEED;

      const md = mouseDeltaRef.current;
      if (md.dx !== 0 || md.dy !== 0) {
        // 0.005 rad per pixel, matching arcball, as a per-second rate.
        yaw -= md.dx * 0.005 / Math.max(dt, 0.001);
        pitch -= md.dy * 0.005 / Math.max(dt, 0.001);
        md.dx = 0;
        md.dy = 0;
      }

      const hasInput =
        forward !== 0 ||
        right !== 0 ||
        up !== 0 ||
        yaw !== 0 ||
        pitch !== 0 ||
        roll !== 0;

      if (hasInput) {
        applyViewportCommand(scene, {
          type: "fly_tick",
          dt,
          forward,
          right,
          up,
          yaw,
          pitch,
          roll,
        });
        markInteractiveDirty();
        setLowRes();
        emitPresence();
        hadInputRef.current = true;
      } else if (hadInputRef.current) {
        // Input just stopped.
        scheduleFullRes();
        emitPresence();
        hadInputRef.current = false;
      }
      // Held keys move the camera every frame without further input.
      return hasInput;
    }

    return frameClock.subscribe(tick);
  }, [
    isActive,
    sceneRef,
    pressedKeysRef,
    applyViewportCommand,
    emitPresence,
    markInteractiveDirty,
    setLowRes,
    scheduleFullRes,
  ]);

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      draggingRef.current = true;
      (e.currentTarget as HTMLElement)?.setPointerCapture(e.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
      mouseDeltaRef.current.dx += e.movementX;
      mouseDeltaRef.current.dy += e.movementY;
    },
    [],
  );

  const onPointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp };
}
