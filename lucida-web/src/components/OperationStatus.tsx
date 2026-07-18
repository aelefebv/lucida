import type { OperationState } from "../hooks/useLatestOperation.ts";

interface Props {
  state: OperationState;
  onDismiss: () => void;
  className?: string;
}

/** Shared accessible presentation for normal activity and queued failures. */
export function OperationStatus({ state, onDismiss, className }: Props) {
  if (state.phase === "idle") return null;
  if (state.phase !== "error") {
    return (
      <div
        className={className}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-operation-phase={state.phase}
      >
        {state.message}
      </div>
    );
  }
  return (
    <div
      className={className}
      role="alert"
      aria-atomic="true"
      data-operation-phase="error"
    >
      <span>{state.message}</span>
      <span>{state.detail}</span>
      <span className="operation-status-actions">
        {state.retry && (
          <button type="button" onClick={state.retry}>Retry</button>
        )}
        <button type="button" onClick={onDismiss}>Dismiss</button>
      </span>
    </div>
  );
}
