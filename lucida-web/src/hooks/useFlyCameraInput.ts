import { useRef, useEffect, useCallback } from "react";
import type { WasmScene } from "lucida-core";
import { isActionPressed } from "../config/keyBindings";
import type { ViewportCommand } from "../commands.ts";

/**
 * Hook that drives the fly camera via a RAF loop + mouselook.
 *
 * When active, reads pressed keys each frame to compute WASD/QE translation,
 * and reads accumulated mouse delta for yaw/pitch rotation.
 *
 * Returns pointer handlers for mouselook that VolumeViewer spreads onto the canvas.
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
  // Accumulated mouse delta for yaw/pitch (reset each frame)
  const mouseDeltaRef = useRef({ dx: 0, dy: 0 });
  // Track pointer drag state
  const draggingRef = useRef(false);
  // RAF ID for cleanup
  const rafRef = useRef(0);
  // Last frame timestamp
  const lastTimeRef = useRef(0);
  // Whether any input was active last frame (for presence throttling)
  const hadInputRef = useRef(false);

  // RAF loop
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

      // Movement from WASD/QE
      let forward = 0;
      let right = 0;
      let up = 0;
      if (isActionPressed(pressed, "fly.forward")) forward += 1;
      if (isActionPressed(pressed, "fly.backward")) forward -= 1;
      if (isActionPressed(pressed, "fly.right")) right += 1;
      if (isActionPressed(pressed, "fly.left")) right -= 1;
      if (isActionPressed(pressed, "fly.up")) up += 1;
      if (isActionPressed(pressed, "fly.down")) up -= 1;

      // Keyboard rotation from IJKL/OU (PI/4 rad/sec)
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

      // Mouse-look yaw/pitch (accumulated between frames)
      const md = mouseDeltaRef.current;
      if (md.dx !== 0 || md.dy !== 0) {
        // Convert pixel delta to radians/sec equivalent
        // Sensitivity: 0.005 radians per pixel (same as arcball)
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
        // Input just stopped — schedule full res and emit presence
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

  // Pointer handlers for mouselook
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
