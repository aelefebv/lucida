import { useCallback, useState } from "react";
import {
  hasLocalFilePaths,
  localFilePathCount,
} from "../savedView/captureBuilder.ts";
import type { SavedView } from "../savedView/types.ts";

interface Props {
  /** Returns the live SavedView (used to surface the local-file warning). */
  getCurrentSavedView: () => SavedView | null;
}

interface ToastMessage {
  id: number;
  text: string;
  kind: "info" | "warn";
}

let toastIdCounter = 0;

/**
 * Toolbar button that copies the current URL to the clipboard. Displays
 * a transient inline notification with the link size, plus warnings for
 * local-file paths and oversize URLs.
 */
export function ShareToolbarButton({ getCurrentSavedView }: Props) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const pushToast = useCallback((text: string, kind: ToastMessage["kind"] = "info") => {
    const id = ++toastIdCounter;
    setToasts((prev) => [...prev, { id, text, kind }]);
    // Auto-dismiss after 4 s.
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const handleClick = useCallback(async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
    } catch (e) {
      pushToast(`Copy failed: ${e instanceof Error ? e.message : String(e)}`, "warn");
      return;
    }
    const sizeKb = (url.length / 1024).toFixed(1);
    pushToast(`Copied URL (${sizeKb} KB)`, "info");

    // Local-file warning: per
    // wiki/decisions/0014-local-file-datasets-personal-only-in-saved-views.md
    const view = getCurrentSavedView();
    if (view && hasLocalFilePaths(view)) {
      const n = localFilePathCount(view);
      pushToast(
        `This view references local files (${n} path${n === 1 ? "" : "s"}) — link only works on a server with the same files at the same paths.`,
        "warn",
      );
    }

    // Soft 4 KB warning.
    if (url.length > 4096) {
      pushToast(
        "Link is large — may not fit in some chat apps; consider saving as a bookmark.",
        "warn",
      );
    }
  }, [getCurrentSavedView, pushToast]);

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        title="Copy a link to this view"
        style={{
          padding: "0.375rem 0.75rem",
          fontSize: "0.875rem",
          whiteSpace: "nowrap",
        }}
      >
        Share view
      </button>
      <ShareToastTray toasts={toasts} />
    </>
  );
}

function ShareToastTray({ toasts }: { toasts: ToastMessage[] }) {
  if (toasts.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 9999,
        maxWidth: 360,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          style={{
            padding: "0.5rem 0.75rem",
            background: t.kind === "warn" ? "#5a3a00" : "#222",
            color: "#fff",
            borderRadius: 6,
            border: t.kind === "warn" ? "1px solid #b88500" : "1px solid #444",
            fontSize: "0.85rem",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            pointerEvents: "auto",
          }}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
