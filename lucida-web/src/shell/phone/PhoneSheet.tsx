import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { usePreference } from "../../theme/preferences.ts";
import { readSafeAreaInsets } from "../../theme/viewport.ts";
import { rightPanelPreference } from "../layoutPreferences.ts";
import type { RailPanel } from "../RightRail.tsx";
import { openRightPanel, useEscapeCloses, usePanelOpen } from "../sidePanels.ts";
import { nextSnap, SHEET_SNAPS, sheetHeights, snapAfterDrag, stepSnap, type SheetSnap } from "./sheet.ts";
import { useKeyboardInset, useTypingOutside } from "./useKeyboard.ts";
import "./PhoneSheet.css";

/** A finger that moves less than this on the handle tapped it. */
const TAP_SLOP_PX = 6;
/** A finger that rests this long before lifting has stopped flinging. */
const FLING_IDLE_MS = 100;
/** A click this soon after a pointer lifts is that pointer's own click. */
const CLICK_AFTER_POINTER_MS = 1000;

const SNAP_NAMES: Record<SheetSnap, string> = { peek: "Peek", half: "Half", full: "Full" };

export interface PhoneSheetProps {
  /** Always in view at the top: the channel chips and the dimension controls. */
  peek: ReactNode;
  /**
   * Tabs that stand in for the left panel: the layers, then the groups of a
   * collection. Showing one opens the left panel, so its command and
   * Escape work as they do beside the canvas.
   */
  layerTabs: readonly RailPanel[];
  /** The rail's panels. Showing one opens the rail's panel, by its id. */
  railTabs: readonly RailPanel[];
}

/**
 * The phone's one bottom sheet. At peek it holds the controls used most;
 * dragged or tapped up to half or full it shows the panels as tabs. The
 * canvas ends where the peek begins, so the sheet covers it only when raised,
 * and wholly only at full. It rides above the on-screen keyboard; while a
 * comment is typed on the canvas it keeps only its handle there.
 *
 * Raised means a side panel is open (sidePanels.ts), so the panel commands
 * and Escape drive it, and a phone turned sideways keeps the panel open.
 */
export function PhoneSheet({ peek, layerTabs, railTabs }: PhoneSheetProps) {
  const [leftOpen, setLeftOpen] = usePanelOpen("left");
  const [rightOpen, setRightOpen] = usePanelOpen("right");
  const [railId] = usePreference(rightPanelPreference);
  const [layerTabId, setLayerTabId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<"half" | "full">("half");
  const [lastTab, setLastTab] = useState<string | null>(null);

  const allTabs = [...layerTabs, ...railTabs];
  const has = (tabs: readonly RailPanel[], id: string | null) => id !== null && tabs.some((t) => t.id === id);
  const layerTab = has(layerTabs, layerTabId) ? layerTabId : (layerTabs[0]?.id ?? null);
  const railTab = has(railTabs, railId) ? railId : (railTabs[0]?.id ?? null);
  const openTab = leftOpen ? layerTab : rightOpen ? railTab : null;
  if (openTab !== null && openTab !== lastTab) setLastTab(openTab);
  const shownTab = openTab ?? (has(allTabs, lastTab) ? lastTab : layerTab);

  const sheetRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const pointerEndedAt = useRef(-Infinity);
  const keyboard = useKeyboardInset();
  // A comment typed on the canvas needs the room, so the sheet keeps only
  // its handle above the keyboard. A field in the sheet raises the sheet
  // with it instead.
  const tucked = useTypingOutside(sheetRef) && keyboard > 0;
  const snap: SheetSnap = tucked || openTab === null ? "peek" : expanded;

  // The room is what the sheet may cover: everything under the top bar.
  const [room, setRoom] = useState(0);
  const [headHeight, setHeadHeight] = useState(0);
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const head = headRef.current;
    const center = dock?.parentElement;
    if (!dock || !head || !center || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      setRoom(center.clientHeight);
      setHeadHeight(head.offsetHeight);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(center);
    observer.observe(head);
    measure();
    return () => observer.disconnect();
  }, []);
  // The keyboard covers the home indicator, so the inset applies only without it.
  const safeBottom = keyboard > 0 ? 0 : readSafeAreaInsets().bottom;
  const heights = sheetHeights(room - keyboard, headHeight + safeBottom);
  const covers = heights[snap] + keyboard;
  useLayoutEffect(() => {
    // Toasts rise above whatever the sheet covers (Toast.css).
    const root = document.documentElement.style;
    root.setProperty("--toast-clear-bottom", `${covers}px`);
    return () => {
      root.removeProperty("--toast-clear-bottom");
    };
  }, [covers]);

  const choose = (id: string) => {
    if (has(layerTabs, id)) {
      setLayerTabId(id);
      setLeftOpen(true);
    } else {
      openRightPanel(id);
    }
  };
  const close = useCallback(() => {
    setLeftOpen(false);
    setRightOpen(false);
  }, [setLeftOpen, setRightOpen]);
  const settle = (next: SheetSnap) => {
    if (next === "peek") {
      close();
      return;
    }
    setExpanded(next);
    if (openTab === null && shownTab !== null) choose(shownTab);
  };
  useEscapeCloses(openTab !== null, close);

  // A thread opened on the canvas belongs above the sheet, not under it.
  const raised = openTab !== null;
  useEffect(() => {
    const layers = document.querySelector(".lc-canvas-stage-layers");
    if (!raised || !layers) return;
    const observer = new MutationObserver(() => {
      if (layers.querySelector('[role="dialog"]')) close();
    });
    observer.observe(layers, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [raised, close]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const sheet = sheetRef.current;
    if (event.button !== 0 || !sheet) return;
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    handle.setPointerCapture(pointerId);
    const startY = event.clientY;
    const startHeight = heights[snap];
    let height = startHeight;
    let moved = false;
    let lastY = startY;
    let lastTime = event.timeStamp;
    let velocity = 0;
    const onMove = (move: globalThis.PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const travel = startY - move.clientY;
      if (!moved && Math.abs(travel) < TAP_SLOP_PX) return;
      moved = true;
      height = Math.min(heights.full, Math.max(heights.peek, startHeight + travel));
      // Written straight to the element, so a drag doesn't re-render the panels inside.
      sheet.dataset.dragging = "";
      sheet.style.height = `${height}px`;
      const elapsed = move.timeStamp - lastTime;
      if (elapsed > 0) velocity = (lastY - move.clientY) / elapsed;
      lastY = move.clientY;
      lastTime = move.timeStamp;
    };
    const onEnd = (end: globalThis.PointerEvent) => {
      if (end.pointerId !== pointerId) return;
      pointerEndedAt.current = end.timeStamp;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      delete sheet.dataset.dragging;
      if (!moved) {
        if (end.type === "pointerup") settle(nextSnap(snap));
        return;
      }
      if (end.timeStamp - lastTime > FLING_IDLE_MS) velocity = 0;
      const target = snapAfterDrag(heights, height, velocity);
      // React writes the height only when the snap changes; landing back on
      // the same one leaves the dragged height in place otherwise.
      sheet.style.height = `${heights[target]}px`;
      settle(target);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };

  // A screen reader's activation arrives as a click with no pointer before
  // it; a finger's tap already stepped the sheet on pointerup.
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.timeStamp - pointerEndedAt.current < CLICK_AFTER_POINTER_MS) return;
    settle(nextSnap(snap));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next: SheetSnap | null =
      event.key === "Enter" || event.key === " "
        ? nextSnap(snap)
        : event.key === "ArrowUp"
          ? stepSnap(snap, 1)
          : event.key === "ArrowDown"
            ? stepSnap(snap, -1)
            : event.key === "Home"
              ? "peek"
              : event.key === "End"
                ? "full"
                : null;
    if (next === null) return;
    event.preventDefault();
    settle(next);
  };

  return (
    <div ref={dockRef} className="lc-phone-sheet-dock" style={{ height: heights.peek + keyboard }}>
      <section
        ref={sheetRef}
        className="lc-phone-sheet"
        aria-label="Viewer controls"
        data-snap={snap}
        data-keyboard={keyboard > 0 || undefined}
        style={{ bottom: keyboard, height: heights[snap] }}
      >
        <div ref={headRef} className="lc-phone-sheet-head">
          <div
            className="lc-phone-sheet-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Viewer controls height"
            aria-valuemin={0}
            aria-valuemax={SHEET_SNAPS.length - 1}
            aria-valuenow={SHEET_SNAPS.indexOf(snap)}
            aria-valuetext={SNAP_NAMES[snap]}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onClick={onClick}
            onKeyDown={onKeyDown}
            data-testid="sheet-handle"
          >
            <span className="lc-phone-sheet-grip" aria-hidden="true" />
          </div>
          <div className="lc-phone-sheet-peek" hidden={tucked}>
            {peek}
          </div>
        </div>
        <div className="lc-phone-sheet-body" inert={snap === "peek"}>
          {shownTab !== null && (
            <Tabs
              className="lc-phone-sheet-tabs"
              selectedKey={shownTab}
              onSelectionChange={(key) => choose(String(key))}
            >
              <TabList className="lc-phone-sheet-tablist" aria-label="Panels">
                {allTabs.map((tab) => {
                  const count = tab.badge?.count ?? 0;
                  const TabIcon = tab.icon;
                  return (
                    <Tab
                      key={tab.id}
                      id={tab.id}
                      className="lc-phone-sheet-tab"
                      aria-label={count > 0 ? `${tab.label} (${tab.badge?.label})` : tab.label}
                      data-testid={`sheet-tab-${tab.id}`}
                    >
                      <span className="lc-phone-sheet-tab-icon">
                        <TabIcon size={20} aria-hidden />
                        {count > 0 && (
                          <span className="lc-phone-sheet-badge" aria-hidden="true">
                            {count > 99 ? "99+" : count}
                          </span>
                        )}
                      </span>
                      <span className="lc-phone-sheet-tab-label">{tab.shortLabel ?? tab.label}</span>
                    </Tab>
                  );
                })}
              </TabList>
              {allTabs.map((tab) => (
                <TabPanel key={tab.id} id={tab.id} className="lc-phone-sheet-panel" shouldForceMount>
                  {tab.render(snap !== "peek" && tab.id === openTab)}
                </TabPanel>
              ))}
            </Tabs>
          )}
        </div>
      </section>
    </div>
  );
}
