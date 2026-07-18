import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ApplierState, SavedViewApplier } from "../savedView/applier.ts";

interface Props {
  applier: SavedViewApplier;
}

/**
 * Subtle inline banner displayed during recipient apply. Subscribes to the
 * `SavedViewApplier` state and shows progress (`Loading shared view: 2 of
 * 4 datasets…`), with per-dataset failure indicators.
 *
 * Auto-hides shortly after `inProgress` flips to false (so the user can
 * see the final state, including any partial failures).
 */
export function LoadingViewBanner({ applier }: Props) {
  const state = useSyncExternalStore<ApplierState>(
    (cb) => applier.subscribe(() => cb()),
    () => applier.getState(),
    () => applier.getState(),
  );
  // Manual dismiss flag, set to true at the start of a fresh apply and
  // toggled by the user's Dismiss button. Stays in sync with `inProgress`
  // — see the effect below.
  const [dismissed, setDismissed] = useState(false);
  const inProgressPrevRef = useRef(state.inProgress);

  useEffect(() => {
    // Reset dismissed flag whenever a new apply starts.
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
      data-testid="loading-view-banner"
      data-floating-safe-region
      style={{
        position: "absolute",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        background: state.anyOpenFailed || hasWarnings ? "var(--warning-surface)" : "var(--info-surface)",
        color: "var(--text-primary)",
        padding: "0.5rem 0.875rem",
        borderRadius: 6,
        border: state.anyOpenFailed || hasWarnings ? "1px solid var(--warning-border)" : "1px solid var(--info-border)",
        fontSize: "0.85rem",
        zIndex: 50,
        maxWidth: 480,
        boxShadow: "var(--shadow-popover)",
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
            color: "var(--text-primary)",
            border: "1px solid var(--border-strong)",
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
