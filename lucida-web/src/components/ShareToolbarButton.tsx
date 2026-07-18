import { useCallback, useState } from "react";
import {
  hasLocalFilePaths,
  localFilePathCount,
} from "../savedView/captureBuilder.ts";
import type { CommittedShareLink } from "../savedView/urlSync.ts";

interface Props {
  /** Captures one view and returns the URL after that exact capture is committed. */
  prepareShareLink: () => Promise<CommittedShareLink>;
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
export function ShareToolbarButton({ prepareShareLink }: Props) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [status, setStatus] = useState<"idle" | "pending" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const pushToast = useCallback((text: string, kind: ToastMessage["kind"] = "info") => {
    const id = ++toastIdCounter;
    setToasts((prev) => [...prev, { id, text, kind }]);
    // Auto-dismiss after 4 s.
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const handleClick = useCallback(async () => {
    if (status === "pending") return;
    setStatus("pending");
    setError(null);
    let committed: CommittedShareLink;
    try {
      committed = await prepareShareLink();
      await navigator.clipboard.writeText(committed.url);
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setStatus("idle");
    const { url, view } = committed;
    const sizeKb = (url.length / 1024).toFixed(1);
    pushToast(`Copied URL (${sizeKb} KB)`, "info");

    // Local-file warning: per
    // wiki/decisions/0014-local-file-datasets-personal-only-in-saved-views.md
    if (hasLocalFilePaths(view)) {
      const n = localFilePathCount(view);
      pushToast(
        `This view references local files (${n} path${n === 1 ? "" : "s"}) — link only works on a server with the same files at the same paths.`,
        "warn",
      );
    }

    // Soft 4 KB warning.
    if (url.length > 4096) {
      pushToast(
        "Link is large — it may not fit in some chat apps; consider saving it as a workspace view.",
        "warn",
      );
    }
  }, [prepareShareLink, pushToast, status]);

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={status === "pending"}
        aria-busy={status === "pending"}
        title="Copy a link to this view"
        style={{
          padding: "0.375rem 0.75rem",
          fontSize: "0.875rem",
          whiteSpace: "nowrap",
        }}
      >
        {status === "pending" ? "Preparing link…" : "Share view"}
      </button>
      {error && (
        <div className="share-copy-error" role="alert">
          <span>Could not copy this view: {error}</span>
          <button type="button" onClick={() => void handleClick()}>Retry</button>
          <button type="button" onClick={() => { setError(null); setStatus("idle"); }}>Dismiss</button>
        </div>
      )}
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
            background: t.kind === "warn" ? "var(--warning-surface)" : "var(--surface-2)",
            color: "var(--text-primary)",
            borderRadius: 6,
            border: t.kind === "warn" ? "1px solid var(--warning-border)" : "1px solid var(--border-strong)",
            fontSize: "0.85rem",
            boxShadow: "var(--shadow-popover)",
            pointerEvents: "auto",
          }}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
