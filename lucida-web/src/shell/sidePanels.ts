import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getPreference, setPreference, usePreference } from "../theme/preferences.ts";
import { getViewportClass, useViewportClass, type ViewportClass } from "../theme/viewport.ts";
import { pushEscapeLayer } from "../ui/escape.ts";
import { isTypingTarget, OVERLAY_ATTRIBUTE } from "../ui/shortcuts.ts";
import { leftPanelOpenPreference, rightPanelOpenPreference, rightPanelPreference } from "./layoutPreferences.ts";

export type PanelSide = "left" | "right";

/**
 * How the side panels sit. Docked beside the canvas on desktop. Below it they
 * overlay the canvas instead, so opening one never resizes the canvas.
 */
export type PanelMode = "docked" | "overlay";

export function panelModeFor(viewport: ViewportClass): PanelMode {
  return viewport === "desktop" ? "docked" : "overlay";
}

export function usePanelMode(): PanelMode {
  return panelModeFor(useViewportClass());
}

const DOCKED_OPEN = { left: leftPanelOpenPreference, right: rightPanelOpenPreference } as const;

// Overlay panels start closed and at most one shows, so one value holds
// them. It lives in memory: opening a panel on a tablet must never change
// what a desktop window opens with.
let overlaySide: PanelSide | null = null;
const overlayListeners = new Set<() => void>();

function setOverlaySide(side: PanelSide | null): void {
  if (side === overlaySide) return;
  overlaySide = side;
  for (const listener of [...overlayListeners]) listener();
}

function subscribeOverlay(listener: () => void): () => void {
  overlayListeners.add(listener);
  return () => overlayListeners.delete(listener);
}

const currentMode = (): PanelMode => panelModeFor(getViewportClass());

/** Whether a side panel shows, in the mode the window is in now. */
export function isPanelOpen(side: PanelSide): boolean {
  return currentMode() === "docked" ? getPreference(DOCKED_OPEN[side]) : overlaySide === side;
}

export function setPanelOpen(side: PanelSide, open: boolean): void {
  if (currentMode() === "docked") setPreference(DOCKED_OPEN[side], open);
  else if (open) setOverlaySide(side);
  else if (overlaySide === side) setOverlaySide(null);
}

export function togglePanel(side: PanelSide): void {
  setPanelOpen(side, !isPanelOpen(side));
}

/** Opens a rail panel by id. */
export function openRightPanel(id: string): void {
  setPreference(rightPanelPreference, id);
  setPanelOpen("right", true);
}

/** Read and set whether a side panel shows, kept current across modes. */
export function usePanelOpen(side: PanelSide): [boolean, (open: boolean) => void] {
  const mode = usePanelMode();
  const [docked] = usePreference(DOCKED_OPEN[side]);
  const overlay = useSyncExternalStore(subscribeOverlay, () => overlaySide, () => null);
  const setOpen = useCallback((open: boolean) => setPanelOpen(side, open), [side]);
  return [mode === "docked" ? docked : overlay === side, setOpen];
}

/**
 * The open rail panel's id, or null when the panel area is closed. For code
 * outside the rail that should run only while a panel shows.
 */
export function useOpenRightPanel(): string | null {
  const [open] = usePanelOpen("right");
  const [panelId] = usePreference(rightPanelPreference);
  return open ? panelId : null;
}

/**
 * Escape closes an open overlay panel. The viewer's Escape shortcut runs the
 * layer, so the key closes the panel and nothing else; without that shortcut
 * mounted, or with focus where shortcuts don't fire, the listener here does.
 * A popover open inside the panel takes the key first.
 */
export function useEscapeCloses(active: boolean, close: () => void): void {
  useEffect(() => {
    if (!active) return;
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      close();
    };
    const pop = pushEscapeLayer(once);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isTypingTarget(event.target)) return;
      if (event.target instanceof Element && event.target.closest(`[${OVERLAY_ATTRIBUTE}]`)) return;
      event.preventDefault();
      once();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      pop();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [active, close]);
}

/** Resets overlay state. Tests only. */
export function __resetSidePanelsForTesting(): void {
  overlaySide = null;
}
