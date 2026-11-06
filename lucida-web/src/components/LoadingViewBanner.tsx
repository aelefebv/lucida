import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ApplierState, SavedViewApplier } from "../savedView/applier.ts";

interface Props {
  applier: SavedViewApplier;
}

/**
 * Inline banner showing a recipient's saved-view apply progress, with
 * per-dataset failure indicators. Auto-hides shortly after a clean finish;
 * failures and warnings stay until dismissed.
 */
export function LoadingViewBanner({ applier }: Props) {
  const state = useSyncExternalStore<ApplierState>(
    (cb) => applier.subscribe(() => cb()),
    () => applier.getState(),
    () => applier.getState(),
  );
  // Cleared when a new apply starts.
  const [dismissed, setDismissed] = useState(false);
  const inProgressPrevRef = useRef(state.inProgress);

  useEffect(() => {
    if (state.inProgress && !inProgressPrevRef.current) {
      setDismissed(false);
    }
    inProgressPrevRef.current = state.inProgress;
  }, [state.inProgress]);

  // Auto-hide after success (no failures/warnings): wait 1.5s then dismiss.
  useEffect(() => {
    if (state.inProgress) return;
    if (state.openStatuses.length === 0) return;
    if (state.anyOpenFailed) return;
    if (state.warnings.length > 0) return;
    const t = setTimeout(() => setDismissed(true), 1500);
    return () => clearTimeout(t);
  }, [state.inProgress, state.openStatuses.length, state.anyOpenFailed, state.warnings.length]);

  const hasWarnings = state.warnings.length > 0;
  const visible = !dismissed && (state.inProgress || state.openStatuses.length > 0 || hasWarnings);
  if (!visible) return null;

  const total = state.totalToOpen;
  const ok = state.okOpened;
  const showProgress = total > 0;

  return (
    <div
      role="status"
      style={{
        background: state.anyOpenFailed || hasWarnings ? "#5a3a00" : "#1a3a5a",
        color: "#fff",
        padding: "0.5rem 0.875rem",
        borderRadius: 6,
        border: state.anyOpenFailed || hasWarnings ? "1px solid #b88500" : "1px solid #4080c0",
        fontSize: "0.85rem",
        maxWidth: "min(480px, 100%)",
        boxSizing: "border-box",
        boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
      }}
    >
      <div>
        {state.inProgress
          ? showProgress
            ? `Loading shared view: ${ok} of ${total} datasets…`
            : "Loading shared view…"
          : state.anyOpenFailed
          ? `Loaded ${ok} of ${total} datasets — some failed.`
          : hasWarnings
          ? "Loaded shared view with warnings."
          : `Loaded shared view`}
      </div>
      {hasWarnings && (
        <ul style={{ margin: "0.4rem 0 0 1rem", padding: 0, listStyle: "disc" }}>
          {state.warnings.map((warning) => (
            <li key={warning} style={{ fontSize: "0.8rem", opacity: 0.92 }}>
              {warning}
            </li>
          ))}
        </ul>
      )}
      {state.anyOpenFailed && (
        <ul style={{ margin: "0.4rem 0 0 1rem", padding: 0, listStyle: "disc" }}>
          {state.openStatuses
            .filter((s) => s.state === "error")
            .map((s) => (
              <li key={s.url} style={{ fontSize: "0.8rem", opacity: 0.92 }}>
                <code style={{ wordBreak: "break-all" }}>{s.url}</code>
                {s.error ? `: ${s.error}` : ""}
              </li>
            ))}
        </ul>
      )}
      {!state.inProgress && (
        <button
          type="button"
          onClick={() => setDismissed(true)}
          style={{
            marginTop: 6,
            padding: "0.2rem 0.5rem",
            fontSize: "0.75rem",
            background: "transparent",
            color: "#fff",
            border: "1px solid #888",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
