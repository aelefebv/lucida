import { useCallback, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { usePreference } from "../theme/preferences.ts";
import { useShortcut } from "../ui/shortcuts.ts";
import { LEFT_PANEL_MAX_WIDTH, LEFT_PANEL_MIN_WIDTH, leftPanelWidthPreference } from "./layoutPreferences.ts";
import { PanelScrim } from "./PanelScrim.tsx";
import { useEscapeCloses, usePanelMode, usePanelOpen } from "./sidePanels.ts";
import "./LeftPanel.css";

const KEY_STEP = 16;

function clampWidth(width: number): number {
  return Math.round(Math.min(LEFT_PANEL_MAX_WIDTH, Math.max(LEFT_PANEL_MIN_WIDTH, width)));
}

export interface LeftPanelProps {
  /** Names the panel for assistive tech. */
  label: string;
  children: ReactNode;
}

/**
 * The collapsible panel at the left; `Alt [` toggles it. Collapsed, it stays
 * mounted, so what is expanded inside it survives. Docked, it is resizable,
 * and its width and whether it is open persist per browser. As an overlay it
 * slides over the canvas at a fixed width, starts closed, and closes on a tap
 * outside or Escape.
 */
export function LeftPanel({ label, children }: LeftPanelProps) {
  const overlay = usePanelMode() === "overlay";
  const [open, setOpen] = usePanelOpen("left");
  const close = useCallback(() => setOpen(false), [setOpen]);
  useEscapeCloses(overlay && open, close);
  const [storedWidth, setStoredWidth] = usePreference(leftPanelWidthPreference);
  // The width while a drag is in progress, committed once on release rather
  // than written to storage on every pointer move.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? storedWidth;

  useShortcut({
    id: "panels.toggleLeft",
    keys: "Alt+[",
    label: "Show or hide the left panel",
    group: "Panels",
    onTrigger: () => setOpen(!open),
  });

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    let latest = startWidth;
    handle.setPointerCapture(event.pointerId);
    document.body.dataset.lcResizing = "col";
    const onMove = (move: globalThis.PointerEvent) => {
      latest = clampWidth(startWidth + move.clientX - startX);
      setDragWidth(latest);
    };
    const onEnd = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("lostpointercapture", onEnd);
      delete document.body.dataset.lcResizing;
      setStoredWidth(latest);
      setDragWidth(null);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("lostpointercapture", onEnd);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === "ArrowLeft"
        ? width - KEY_STEP
        : event.key === "ArrowRight"
          ? width + KEY_STEP
          : event.key === "Home"
            ? LEFT_PANEL_MIN_WIDTH
            : event.key === "End"
              ? LEFT_PANEL_MAX_WIDTH
              : null;
    if (next === null) return;
    event.preventDefault();
    setStoredWidth(clampWidth(next));
  };

  return (
    <>
      {overlay && open && <PanelScrim onDismiss={close} />}
      <aside
        className="lc-left-panel"
        aria-label={label}
        hidden={!open}
        data-mode={overlay ? "overlay" : "docked"}
        style={overlay ? undefined : ({ "--left-panel-width": `${width}px` } as CSSProperties)}
      >
        <div className="lc-left-panel-body">{children}</div>
        {!overlay && (
          <div
            className="lc-left-panel-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${label.toLowerCase()}`}
            aria-valuemin={LEFT_PANEL_MIN_WIDTH}
            aria-valuemax={LEFT_PANEL_MAX_WIDTH}
            aria-valuenow={width}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            data-dragging={dragWidth !== null || undefined}
          />
        )}
      </aside>
    </>
  );
}
