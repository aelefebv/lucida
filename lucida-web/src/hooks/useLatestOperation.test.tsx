// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OperationStatus } from "../components/OperationStatus.tsx";
import { useLatestOperation } from "./useLatestOperation.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Harness({ a, b }: { a: Promise<void>; b: Promise<void> }) {
  const operation = useLatestOperation();
  const run = (key: "a" | "b", promise: Promise<void>) => {
    const attempt = operation.begin({
      key,
      pendingMessage: `Running ${key.toUpperCase()}`,
      successMessage: `Finished ${key.toUpperCase()}`,
      failureMessage: `Failed ${key.toUpperCase()}`,
    });
    if (!attempt) return;
    void promise.then(
      () => attempt.succeed(),
      (error) => attempt.fail(error),
    );
  };
  return (
    <>
      <button disabled={operation.isPending("a")} onClick={() => run("a", a)}>A</button>
      <button disabled={operation.isPending("b")} onClick={() => run("b", b)}>B</button>
      <OperationStatus state={operation.state} onDismiss={operation.dismiss} />
    </>
  );
}

afterEach(cleanup);

describe("useLatestOperation", () => {
  it("settles only its own pending key and cannot replace a newer announcement", async () => {
    const a = deferred<void>();
    const b = deferred<void>();
    render(<Harness a={a.promise} b={b.promise} />);

    fireEvent.click(screen.getByRole("button", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "B" }));
    expect(screen.getByRole("button", { name: "A" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "B" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("status").textContent).toBe("Running B");

    await act(async () => a.resolve());
    expect(screen.getByRole("button", { name: "A" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "B" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("status").textContent).toBe("Running B");

    await act(async () => b.resolve());
    expect(screen.getByRole("status").textContent).toBe("Finished B");
  });

  it("keeps an older disjoint failure visible until it is dismissed", async () => {
    const a = deferred<void>();
    const b = deferred<void>();
    render(<Harness a={a.promise} b={b.promise} />);
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "B" }));

    await act(async () => b.resolve());
    expect(screen.getByRole("status").textContent).toBe("Finished B");
    await act(async () => a.reject(new Error("late A")));
    expect(screen.getByRole("alert").textContent).toContain("Failed A");
    expect(screen.getByRole("alert").textContent).toContain("late A");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByRole("status").textContent).toBe("Finished B");
  });

  it("queues failures from independent actions instead of dropping either", async () => {
    const a = deferred<void>();
    const b = deferred<void>();
    render(<Harness a={a.promise} b={b.promise} />);
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    fireEvent.click(screen.getByRole("button", { name: "B" }));

    await act(async () => a.reject(new Error("A broke")));
    await act(async () => b.reject(new Error("B broke")));
    expect(screen.getByRole("alert").textContent).toContain("A broke");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByRole("alert").textContent).toContain("B broke");
  });

  it("replaces a retried failure with truthful pending state", () => {
    const { result } = renderHook(() => useLatestOperation());
    let currentAttempt: ReturnType<typeof result.current.begin> = null;
    const start = () => {
      currentAttempt = result.current.begin({
        key: "save",
        pendingMessage: "Retrying save…",
        successMessage: "Saved.",
        failureMessage: "Could not save.",
        retry: start,
      });
    };

    act(start);
    act(() => currentAttempt?.fail(new Error("network unavailable")));
    expect(result.current.state).toMatchObject({
      phase: "error",
      detail: "network unavailable",
    });

    act(() => {
      if (result.current.state.phase === "error") result.current.state.retry?.();
    });
    expect(result.current.state).toMatchObject({
      phase: "pending",
      message: "Retrying save…",
    });
    expect(result.current.isPending("save")).toBe(true);
  });
});
