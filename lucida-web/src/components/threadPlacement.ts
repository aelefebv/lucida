import { useLayoutEffect, type RefObject } from "react";
import { frameClock } from "../frameClock.ts";
import { readSafeAreaInsets } from "../theme/viewport.ts";

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** How far the thread sits from its pin on each axis. */
export const THREAD_GAP = 12;
/** The least room kept between the thread and the edge it must stay inside. */
const EDGE_MARGIN = 8;

/**
 * Where a thread of `size` goes for a pin at `pin`, as an offset from the
 * pin. Below and to the right by default; on an axis where that runs past
 * `bounds` it flips to the other side of the pin, and where neither side
 * fits it slides along the axis to stay inside. It stays inside even when
 * the pin leaves, so a reply being typed never goes off screen with it.
 */
export function placeThread(
  pin: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
  bounds: Box,
): { left: number; top: number } {
  const along = (at: number, length: number, low: number, high: number) => {
    const after = at + THREAD_GAP;
    const before = at - THREAD_GAP - length;
    const start = after + length <= high ? after : before >= low ? before : after;
    return Math.max(low, Math.min(high - length, start)) - at;
  };
  return {
    left: along(pin.x, size.width, bounds.left, bounds.right),
    top: along(pin.y, size.height, bounds.top, bounds.bottom),
  };
}

function intersect(a: Box, b: Box, inset: number): Box {
  return {
    left: Math.max(a.left, b.left) + inset,
    top: Math.max(a.top, b.top) + inset,
    right: Math.min(a.right, b.right) - inset,
    bottom: Math.min(a.bottom, b.bottom) - inset,
  };
}

/**
 * Keeps an open thread on screen: inside the box that clips it and clear of
 * the safe-area insets. Its pin moves as the view pans, so placement runs on
 * the frame clock, which wakes for everything that moves the pin and idles
 * on a still view. It writes only when the answer changes. The thread caps
 * its size at the room, so a short stage still holds it.
 */
export function useThreadPlacement(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const thread = ref.current;
    if (!thread) return;
    let last = "";
    const place = () => {
      // Looked up each time: a pin that leaves the view hides its anchor,
      // which then has no offset parent until it shows again.
      const anchor = thread.parentElement;
      const clip = anchor?.offsetParent;
      if (!anchor || !clip) return;
      const insets = readSafeAreaInsets();
      const screen: Box = {
        left: insets.left,
        top: insets.top,
        right: window.innerWidth - insets.right,
        bottom: window.innerHeight - insets.bottom,
      };
      const bounds = intersect(clip.getBoundingClientRect(), screen, EDGE_MARGIN);
      const pin = anchor.getBoundingClientRect();
      const roomWidth = Math.max(0, bounds.right - bounds.left);
      const roomHeight = Math.max(0, bounds.bottom - bounds.top);
      const size = {
        width: Math.min(thread.offsetWidth, roomWidth),
        height: Math.min(thread.offsetHeight, roomHeight),
      };
      const { left, top } = placeThread({ x: pin.left, y: pin.top }, size, bounds);
      const key = `${left},${top},${roomWidth},${roomHeight}`;
      if (key === last) return;
      last = key;
      thread.style.left = `${left}px`;
      thread.style.top = `${top}px`;
      thread.style.setProperty("--thread-room-width", `${roomWidth}px`);
      thread.style.setProperty("--thread-room-height", `${roomHeight}px`);
    };
    place();
    // Nothing else wakes the clock when the thread's own content changes its size.
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(frameClock.wake);
    resized?.observe(thread);
    const unsubscribe = frameClock.subscribe(place);
    return () => {
      unsubscribe();
      resized?.disconnect();
    };
  }, [ref]);
}
