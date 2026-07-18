import { useRef, useEffect, useCallback } from "react";
import type { WasmScene } from "lucida-core";
import { isActionPressed } from "../config/keyBindings";
import type { ViewportCommand } from "../commands.ts";
import { DemandDrivenAnimationFrame } from "../demandDrivenAnimationFrame.ts";
import type { KeyState } from "./useKeyState.ts";

/**
 * Hook that drives the fly camera from held keys and mouselook.
 *
 * A frame is requested only when input begins. Held keys explicitly keep the
 * scheduler awake; key release or a one-shot mouse delta settles back to zero
 * pending callbacks.
 *
 * Returns pointer handlers for mouselook that VolumeViewer spreads onto the canvas.
 */
export function useFlyCameraInput(
  sceneRef: React.RefObject<WasmScene | null>,
  mutateViewport: (command: ViewportCommand) => boolean,
  keyState: KeyState,
  isActive: boolean,
  setLowRes: () => void,
  scheduleFullRes: () => void,
) {
  // Accumulated mouse delta for yaw/pitch (reset each frame)
  const mouseDeltaRef = useRef({ dx: 0, dy: 0 });
  // Track pointer drag state
  const draggingRef = useRef(false);
  // Event handlers wake the current effect-owned scheduler through this ref.
  const wakeRef = useRef<(() => void) | null>(null);
  // Last frame timestamp
  const lastTimeRef = useRef(0);
  // Whether any input was active last frame (for presence throttling)
  const hadInputRef = useRef(false);

  // Demand-driven frame owner. Keyboard input continues while a movement key is
  // held; mouse-look consumes one accumulated delta and immediately settles.
  useEffect(() => {
    if (!isActive) return;

    lastTimeRef.current = performance.now();

    const scheduler = new DemandDrivenAnimationFrame((timestamp) => {
      const scene = sceneRef.current;
      const pressed = keyState.pressed;
      if (!scene) return false;

      const dt = Math.min((timestamp - lastTimeRef.current) / 1000, 0.1);
      lastTimeRef.current = timestamp;

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

      const hasKeyboardInput =
        forward !== 0 ||
        right !== 0 ||
        up !== 0 ||
        yaw !== 0 ||
        pitch !== 0 ||
        roll !== 0;

      // Mouse-look yaw/pitch (accumulated between frames)
      const md = mouseDeltaRef.current;
      const hasMouseInput = md.dx !== 0 || md.dy !== 0;
      if (hasMouseInput) {
        // Convert pixel delta to radians/sec equivalent
        // Sensitivity: 0.005 radians per pixel (same as arcball)
        yaw -= md.dx * 0.005 / Math.max(dt, 0.001);
        pitch -= md.dy * 0.005 / Math.max(dt, 0.001);
        md.dx = 0;
        md.dy = 0;
      }

      const hasInput = hasKeyboardInput || hasMouseInput;

      if (hasInput) {
        mutateViewport({
          type: "fly_tick",
          dt,
          forward,
          right,
          up,
          yaw,
          pitch,
          roll,
        });
        setLowRes();
        hadInputRef.current = hasKeyboardInput;
        // Mouse deltas are one-shot. Schedule the high-resolution settle now;
        // held keys defer it until their release wakes one final frame.
        if (!hasKeyboardInput) scheduleFullRes();
      } else if (hadInputRef.current) {
        // Input just stopped — schedule the high-resolution settle frame.
        scheduleFullRes();
        hadInputRef.current = false;
      }

      return hasKeyboardInput;
    });

    const wake = () => {
      if (!scheduler.pending) lastTimeRef.current = performance.now();
      scheduler.wake();
    };
    wakeRef.current = wake;
    const unsubscribe = keyState.subscribe(() => {
      // A fly keydown starts continuous work; the corresponding keyup must wake
      // one final frame so resolution settles. Unrelated controls do neither.
      const pressed = keyState.pressed;
      const relevant =
        isActionPressed(pressed, "fly.forward") ||
        isActionPressed(pressed, "fly.backward") ||
        isActionPressed(pressed, "fly.right") ||
        isActionPressed(pressed, "fly.left") ||
        isActionPressed(pressed, "fly.up") ||
        isActionPressed(pressed, "fly.down") ||
        isActionPressed(pressed, "fly.yawLeft") ||
        isActionPressed(pressed, "fly.yawRight") ||
        isActionPressed(pressed, "fly.pitchUp") ||
        isActionPressed(pressed, "fly.pitchDown") ||
        isActionPressed(pressed, "fly.rollLeft") ||
        isActionPressed(pressed, "fly.rollRight");
      if (relevant || hadInputRef.current) wake();
    });
    if (keyState.pressed.size > 0) wake();

    return () => {
      wakeRef.current = null;
      unsubscribe();
      scheduler.dispose();
    };
  }, [
    isActive,
    sceneRef,
    keyState,
    mutateViewport,
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
      wakeRef.current?.();
    },
    [],
  );

  const onPointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp };
}
