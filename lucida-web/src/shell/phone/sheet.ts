import { getViewportClass } from "../../theme/viewport.ts";
import { setPanelOpen } from "../sidePanels.ts";

/** The heights the phone's bottom sheet rests at. */
export type SheetSnap = "peek" | "half" | "full";

export const SHEET_SNAPS: readonly SheetSnap[] = ["peek", "half", "full"];

export type SheetHeights = Readonly<Record<SheetSnap, number>>;

/** At half, the least a panel gets below the peek, so its first rows show. */
const HALF_PANEL_PX = 240;
/** At half, the least canvas left showing above the sheet. */
const HALF_CANVAS_PX = 160;

/**
 * The sheet's height at each snap. `room` is what it may cover, from the top
 * bar down to the keyboard or the bottom of the screen; `peek` is what its
 * handle and the peek controls need. Half is half the room, or more where
 * the peek would leave a panel too little, and full meets the top bar.
 */
export function sheetHeights(room: number, peek: number): SheetHeights {
  const full = Math.max(0, Math.round(room));
  const low = Math.min(Math.round(peek), full);
  const half = Math.min(full - HALF_CANVAS_PX, Math.max(Math.round(full / 2), low + HALF_PANEL_PX));
  return { peek: low, half: Math.min(full, Math.max(low, half)), full };
}

/** How far ahead a fling carries, in ms of its release speed. */
const FLING_MS = 180;

/**
 * Where a drag of the handle settles: the snap nearest to where its release
 * speed would carry it. `velocity` is in px per ms, upward positive.
 */
export function snapAfterDrag(heights: SheetHeights, height: number, velocity: number): SheetSnap {
  const projected = height + velocity * FLING_MS;
  let best: SheetSnap = "peek";
  for (const snap of SHEET_SNAPS) {
    if (Math.abs(heights[snap] - projected) < Math.abs(heights[best] - projected)) best = snap;
  }
  return best;
}

/** A tap on the handle steps up to full, then back down to peek. */
export function nextSnap(snap: SheetSnap): SheetSnap {
  return snap === "peek" ? "half" : snap === "half" ? "full" : "peek";
}

/** One snap up or down, stopping at the ends, for the arrow keys. */
export function stepSnap(snap: SheetSnap, direction: 1 | -1): SheetSnap {
  const index = SHEET_SNAPS.indexOf(snap) + direction;
  return SHEET_SNAPS[Math.max(0, Math.min(SHEET_SNAPS.length - 1, index))];
}

/** Below this, a shorter visual viewport is browser chrome moving, not a keyboard. */
const KEYBOARD_MIN_PX = 80;

/**
 * How much of the layout viewport's bottom the on-screen keyboard covers, in
 * CSS pixels. The keyboard shrinks the visual viewport and leaves the layout
 * as it is, so the gap below the visual viewport is the keyboard. A page
 * zoomed in shrinks the visual viewport too, so a scaled one counts as none.
 */
export function keyboardInset(
  layoutHeight: number,
  visual: { readonly height: number; readonly offsetTop: number; readonly scale: number } | null | undefined,
): number {
  if (!visual || Math.abs(visual.scale - 1) > 0.01) return 0;
  const covered = Math.round(layoutHeight - visual.height - visual.offsetTop);
  return covered >= KEYBOARD_MIN_PX ? covered : 0;
}

/**
 * Lowers the phone's sheet to peek, for a pick in it that moves the view, so
 * the view shows. Does nothing wider than a phone, where the panels are
 * beside or over the canvas and the person closes them.
 */
export function revealCanvas(): void {
  if (getViewportClass() !== "phone") return;
  setPanelOpen("left", false);
  setPanelOpen("right", false);
}
