import { useSyncExternalStore } from "react";
import {
  IDLE_VIEWPORT_LOADING_STATE,
  type ViewportLoadingStore,
} from "../viewportLoadingState.ts";
import "./ViewportLoadingIndicator.css";

interface Props {
  store: ViewportLoadingStore | null;
}

function transitionLabel(source: string | null): string {
  switch (source) {
    case "dimension_t":
      return "Loading timepoint";
    case "dimension_z":
      return "Loading Z plane";
    case "dimension_c":
      return "Loading channel";
    case "collection_group_click":
      return "Loading group";
    case "view_mode_toggle":
      return "Switching view";
    case "explore_navigation":
      return "Loading view";
    default:
      return "Loading visible data";
  }
}

/**
 * A truthful, renderer-owned loading affordance for discrete view changes.
 * It intentionally does not infer readiness from React state or network
 * activity: the backing store joins current worker residency with a completed
 * GPU frame for the requested view.
 */
export function ViewportLoadingIndicator({ store }: Props) {
  const state = useSyncExternalStore(
    store?.subscribeViewportLoading ?? noopSubscribe,
    store?.getViewportLoadingState ?? getIdleState,
    getIdleState,
  );

  if (state.phase === "idle") return null;

  const detail = state.missingChunks === null
    ? "Checking available data"
    : `${state.missingChunks.toLocaleString()} ${state.missingChunks === 1 ? "chunk" : "chunks"} remaining`;

  return (
    <div
      className="viewport-loading-indicator"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="viewport-loading-indicator"
      data-floating-safe-region
    >
      <span className="viewport-loading-indicator-title">{transitionLabel(state.source)}</span>
      <span className="viewport-loading-indicator-detail">{detail}</span>
    </div>
  );
}

function noopSubscribe(): () => void {
  return () => undefined;
}

function getIdleState() {
  return IDLE_VIEWPORT_LOADING_STATE;
}
