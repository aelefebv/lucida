import { useRef, useEffect, useCallback, useMemo } from "react";
import type { WasmScene } from "lucida-core";
import type { HeldAction } from "../config/keyBindings.ts";
import type { ViewportCommand } from "../commands.ts";
import { frameClock } from "../frameClock.ts";

/** What the viewer does around the fly camera's moves. */
export interface FlyCameraCallbacks {
  /**
   * The camera moved on this frame. `atMs` is the earliest pointer event the
   * move answers, on the `performance.now()` clock, or undefined for a move
   * from held keys alone.
   */
  moved: (atMs: number | undefined) => void;
  /** The frame after the last move: no key is held and the pointer is still. */
  stopped: () => void;
}

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
  callbacks: FlyCameraCallbacks,
) {
  const mouseDeltaRef = useRef<{ dx: number; dy: number; atMs: number | undefined }>({ dx: 0, dy: 0, atMs: undefined });
  const draggingRef = useRef(false);
  const lastTimeRef = useRef(0);
  const hadInputRef = useRef(false);
  const callbacksRef = useRef(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  });

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
      const lookedAtMs = md.atMs;
      if (md.dx !== 0 || md.dy !== 0) {
        // 0.005 rad per pixel, matching arcball, as a per-second rate.
        yaw -= md.dx * 0.005 / Math.max(dt, 0.001);
        pitch -= md.dy * 0.005 / Math.max(dt, 0.001);
      }
      md.dx = 0;
      md.dy = 0;
      md.atMs = undefined;

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
        callbacksRef.current.moved(lookedAtMs);
        hadInputRef.current = true;
      } else if (hadInputRef.current) {
        callbacksRef.current.stopped();
        hadInputRef.current = false;
      }
      // Held keys move the camera every frame without further input.
      return hasInput;
    }

    return frameClock.subscribe(tick);
  }, [isActive, sceneRef, pressedKeysRef, applyViewportCommand]);

  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      // The right button opens the view's menu instead.
      if (e.button === 2) return;
      draggingRef.current = true;
      (e.currentTarget as HTMLElement)?.setPointerCapture(e.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const md = mouseDeltaRef.current;
      md.dx += e.movementX;
      md.dy += e.movementY;
      md.atMs ??= e.timeStamp;
    },
    [],
  );

  const onPointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  return useMemo(() => ({ onPointerDown, onPointerMove, onPointerUp }), [onPointerDown, onPointerMove, onPointerUp]);
}
