import { useEffect, useSyncExternalStore } from "react";
import { viewerHistoryShortcut } from "../localViewHistory.ts";
import type { ViewportCoordinator } from "../viewportCoordinator.ts";

interface Props {
  viewport: ViewportCoordinator;
  viewerRef: React.RefObject<HTMLElement | null>;
}

/** Visible local-view Undo/Redo affordances plus the focus-safe keyboard
 * binding. Disabled controls explain the active workspace history state in
 * their title and accessible label instead of failing silently. */
export function ViewportHistoryControls({ viewport, viewerRef }: Props) {
  const state = useSyncExternalStore(
    viewport.subscribeHistory,
    viewport.getHistoryState,
    viewport.getHistoryState,
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = viewerHistoryShortcut(event, viewerRef.current);
      if (!shortcut) return;
      const changed = shortcut === "undo" ? viewport.undo() : viewport.redo();
      if (changed) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewerRef, viewport]);

  return (
    <div className="viewport-history-controls" role="group" aria-label="Local view history">
      <button
        type="button"
        data-testid="viewport-undo"
        onClick={() => viewport.undo()}
        disabled={!state.canUndo}
        title={state.undoReason}
        aria-label={state.undoReason}
      >
        Undo view
      </button>
      <button
        type="button"
        data-testid="viewport-redo"
        onClick={() => viewport.redo()}
        disabled={!state.canRedo}
        title={state.redoReason}
        aria-label={state.redoReason}
      >
        Redo view
      </button>
    </div>
  );
}
