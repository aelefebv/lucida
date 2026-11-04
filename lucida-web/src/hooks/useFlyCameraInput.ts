import { useRef, useEffect, useCallback } from "react";
import type { WasmScene } from "lucida-core";
import { isActionPressed } from "../config/keyBindings";
import type { ViewportCommand } from "../commands.ts";

/**
 * Drives the fly camera from a RAF loop: pressed keys for translation and
 * rotation, accumulated mouse delta for mouselook. Returns the pointer handlers
 * VolumeViewer spreads onto the canvas.
 */
export function useFlyCameraInput(
  sceneRef: React.RefObject<WasmScene | null>,
  applyViewportCommand: (scene: WasmScene, cmd: ViewportCommand) => void,
  pressedKeysRef: React.RefObject<Set<string>>,
  isActive: boolean,
  emitPresence: () => void,
  markInteractiveDirty: () => void,
  setLowRes: () => void,
  scheduleFullRes: () => void,
) {
  const mouseDeltaRef = useRef({ dx: 0, dy: 0 });
  const draggingRef = useRef(false);
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const hadInputRef = useRef(false);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    lastTimeRef.current = performance.now();

    function tick() {
      const scene = sceneRef.current;
      const pressed = pressedKeysRef.current;
      if (!scene) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const now = performance.now();
      const dt = (now - lastTimeRef.current) / 1000; // seconds
      lastTimeRef.current = now;

      let forward = 0;
      let right = 0;
      let up = 0;
      if (isActionPressed(pressed, "fly.forward")) forward += 1;
      if (isActionPressed(pressed, "fly.backward")) forward -= 1;
      if (isActionPressed(pressed, "fly.right")) right += 1;
      if (isActionPressed(pressed, "fly.left")) right -= 1;
      if (isActionPressed(pressed, "fly.up")) up += 1;
      if (isActionPressed(pressed, "fly.down")) up -= 1;

      const ROTATION_SPEED = Math.PI / 4;
      let yaw = 0;
      let pitch = 0;
      let roll = 0;
      if (isActionPressed(pressed, "fly.yawLeft")) yaw += ROTATION_SPEED;
      if (isActionPressed(pressed, "fly.yawRight")) yaw -= ROTATION_SPEED;
      if (isActionPressed(pressed, "fly.pitchUp")) pitch += ROTATION_SPEED;
      if (isActionPressed(pressed, "fly.pitchDown")) pitch -= ROTATION_SPEED;
      if (isActionPressed(pressed, "fly.rollLeft")) roll += ROTATION_SPEED;
      if (isActionPressed(pressed, "fly.rollRight")) roll -= ROTATION_SPEED;

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

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
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
