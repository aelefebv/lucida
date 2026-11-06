import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ApplierState, SavedViewApplier } from "../savedView/applier.ts";
import { Banner } from "../shell/Banner.tsx";

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
  const failures = state.anyOpenFailed
    ? state.openStatuses
        .filter((s) => s.state === "error")
        .map((s) => (
          <Fragment key={s.url}>
            <code className="lc-banner-code">{s.url}</code>
            {s.error ? `: ${s.error}` : ""}
          </Fragment>
        ))
    : [];

  return (
    <Banner
      tone={state.anyOpenFailed || hasWarnings ? "warning" : "info"}
      details={[...state.warnings, ...failures]}
      onDismiss={state.inProgress ? undefined : () => setDismissed(true)}
    >
      {state.inProgress
        ? showProgress
          ? `Loading shared view: ${ok} of ${total} datasets…`
          : "Loading shared view…"
        : state.anyOpenFailed
          ? `Loaded ${ok} of ${total} datasets — some failed.`
          : hasWarnings
            ? "Loaded shared view with warnings."
            : "Loaded shared view"}
    </Banner>
  );
}
