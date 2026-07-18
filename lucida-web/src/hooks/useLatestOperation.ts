import { useCallback, useEffect, useRef, useState } from "react";

export type OperationPhase = "idle" | "pending" | "success" | "error";

export type OperationState =
  | { phase: "idle"; operationId: 0 }
  | {
      phase: "pending" | "success";
      operationId: number;
      key: string;
      message: string;
    }
  | {
      phase: "error";
      operationId: number;
      key: string;
      message: string;
      detail: string;
      retry: (() => void) | null;
    };

export interface BeginOperationOptions {
  /** Stable identity used to reject double-submit for the same action/target. */
  key: string;
  pendingMessage: string;
  successMessage: string;
  failureMessage: string;
  retry?: () => void;
  /** Replace the active invocation for this key (request-refresh semantics). */
  replaceActive?: boolean;
}

export interface OperationHandle {
  /** True while this invocation still owns its action key. */
  isCurrent(): boolean;
  /** True only for the most recently started operation on this UI surface. */
  isLatest(): boolean;
  succeed(): void;
  fail(error: unknown): void;
}

const IDLE: OperationState = { phase: "idle", operationId: 0 };
type OperationFailure = Extract<OperationState, { phase: "error" }>;

/**
 * One reusable async-UI contract for request freshness and presentation state.
 *
 * Each action/target has an independent pending key, so completion of one row
 * cannot clear another row's spinner. Normal pending/success presentation is
 * latest-request-wins, while failures are queued by action key until that
 * action succeeds or the user dismisses it. This prevents a newer disjoint
 * action from silently hiding a failed access-control or row mutation.
 * Unmounting invalidates every handle, preventing late callbacks from publishing.
 */
export function useLatestOperation() {
  const mountedRef = useRef(true);
  const nextIdRef = useRef(1);
  const latestIdRef = useRef(0);
  const activeByKeyRef = useRef(new Map<string, number>());
  const [activityState, setActivityState] = useState<OperationState>(IDLE);
  const [failures, setFailures] = useState<readonly OperationFailure[]>([]);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    // React StrictMode deliberately runs setup → cleanup → setup in
    // development. Re-arm here so the second setup is a live lifecycle.
    mountedRef.current = true;
    const activeByKey = activeByKeyRef.current;
    return () => {
      mountedRef.current = false;
      latestIdRef.current = -1;
      activeByKey.clear();
    };
  }, []);

  const begin = useCallback((options: BeginOperationOptions): OperationHandle | null => {
    if (activeByKeyRef.current.has(options.key) && !options.replaceActive) return null;

    const operationId = nextIdRef.current++;
    latestIdRef.current = operationId;
    activeByKeyRef.current.set(options.key, operationId);
    // A retry owns the failed action key again. Retire only that stale error
    // before publishing pending state so assistive technology and the visible
    // action both say the retry is underway; unrelated failures remain queued.
    setFailures((queued) => queued.filter((failure) => failure.key !== options.key));
    setPendingKeys((current) => {
      const next = new Set(current);
      next.add(options.key);
      return next;
    });
    setActivityState({
      phase: "pending",
      operationId,
      key: options.key,
      message: options.pendingMessage,
    });

    const isCurrent = () => mountedRef.current &&
      activeByKeyRef.current.get(options.key) === operationId;
    const isLatest = () => isCurrent() && latestIdRef.current === operationId;

    const settlePendingKey = () => {
      if (!isCurrent()) return;
      activeByKeyRef.current.delete(options.key);
      setPendingKeys((current) => {
        if (!current.has(options.key)) return current;
        const next = new Set(current);
        next.delete(options.key);
        return next;
      });
    };

    return {
      isCurrent,
      isLatest,
      succeed() {
        const current = isCurrent();
        const publish = isLatest();
        settlePendingKey();
        if (!current) return;
        setFailures((queued) => queued.filter((failure) => failure.key !== options.key));
        if (publish) {
          setActivityState({
            phase: "success",
            operationId,
            key: options.key,
            message: options.successMessage,
          });
        }
      },
      fail(error: unknown) {
        const current = isCurrent();
        settlePendingKey();
        if (!current) return;
        const failure: OperationFailure = {
          phase: "error",
          operationId,
          key: options.key,
          message: options.failureMessage,
          detail: errorMessage(error),
          retry: options.retry ?? null,
        };
        setFailures((queued) => {
          const index = queued.findIndex((item) => item.key === options.key);
          if (index < 0) return [...queued, failure];
          return queued.map((item, itemIndex) => itemIndex === index ? failure : item);
        });
        setActivityState((visible) =>
          visible.operationId === operationId ? IDLE : visible);
      },
    };
  }, []);

  const dismiss = useCallback(() => {
    if (failures.length > 0) {
      setFailures((queued) => queued.slice(1));
      return;
    }
    latestIdRef.current = nextIdRef.current++;
    setActivityState(IDLE);
  }, [failures.length]);

  const isPending = useCallback(
    (key: string) => pendingKeys.has(key),
    [pendingKeys],
  );

  return {
    state: failures[0] ?? activityState,
    begin,
    dismiss,
    isPending,
    hasPending: pendingKeys.size > 0,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  const message = String(error).trim();
  return message && message !== "[object Object]" ? message : "Unknown error";
}
