// @vitest-environment happy-dom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunBoundary } from "../trace/liveProgress.ts";
import type { FrameCaptureResult } from "../renderer/workerProtocol.ts";
import { __resetCommandsForTesting, runCommand } from "../ui/commands.ts";
import { BlankFrameError, encodePreview } from "./encode.ts";
import { PREVIEW_REFRESH_MS, previewWanted, useWorkspacePreview, type WorkspacePreviewOptions } from "./useWorkspacePreview.ts";

const recorder = vi.hoisted(() => {
  const listeners = new Set<(boundary: RunBoundary) => void>();
  return {
    listeners,
    isRunOpen: false,
    quiescence: null as { quiescent: boolean } | null,
    onRunBoundary(listener: (boundary: RunBoundary) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});
vi.mock("../trace/recorder.ts", () => ({ traceRecorder: recorder }));

const toasts = vi.hoisted(() => [] as { title: string; description?: string; tone?: string }[]);
vi.mock("../ui/toastQueue.ts", () => ({
  toast: (options: { title: string; description?: string; tone?: string }) => {
    toasts.push(options);
    return "toast";
  },
}));

const encoded = new Blob(["webp bytes"], { type: "image/webp" });
vi.mock("./encode.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./encode.ts")>()),
  encodePreview: vi.fn(async () => encoded),
}));

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

let calls: Call[];
/** What `HEAD` answers: a date, null for no preview, or an error status. */
let stored: Date | null | number;
let putStatus: number;

function settle(endReason: RunBoundary["endReason"] = "quiescent") {
  for (const listener of [...recorder.listeners]) {
    listener({ runId: "r", cause: { epoch: "content", dirtyKind: "residency", source: "dataset_open" }, endReason, durationUs: 1 });
  }
}

const frame: FrameCaptureResult = { frame: { png: new ArrayBuffer(8), width: 2, height: 1 }, reason: null };

function options(overrides: Partial<WorkspacePreviewOptions> = {}): WorkspacePreviewOptions {
  return {
    workspaceId: "ws-1",
    canUpload: true,
    hasData: true,
    captureFrame: () => Promise.resolve(frame),
    ...overrides,
  };
}

/** Let the HEAD, the idle callback, the capture, and the upload all run. */
async function flush() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // The fallback path; happy-dom's idle callback would run on its own clock.
  vi.stubGlobal("requestIdleCallback", undefined);
  calls = [];
  stored = null;
  putStatus = 200;
  toasts.length = 0;
  recorder.isRunOpen = false;
  recorder.quiescence = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      calls.push({ method, url, body: init.body });
      if (method === "HEAD") {
        if (typeof stored === "number") return new Response(null, { status: stored });
        if (stored === null) return new Response(null, { status: 404 });
        return new Response(null, { status: 200, headers: { "last-modified": stored.toUTCString() } });
      }
      if (putStatus === 200) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ error: "preview_rate_limited", detail: "try again in 3 s" }), {
        status: putStatus,
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  __resetCommandsForTesting();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const puts = () => calls.filter((call) => call.method === "PUT");

describe("previewWanted", () => {
  it("asks for a preview when there is none or it is an hour old", () => {
    const now = Date.parse("2026-01-02T12:00:00Z");
    expect(previewWanted(null, now)).toBe(true);
    expect(previewWanted(new Date(now - PREVIEW_REFRESH_MS), now)).toBe(true);
    expect(previewWanted(new Date(now - PREVIEW_REFRESH_MS + 1000), now)).toBe(false);
  });
});

describe("useWorkspacePreview, automatically", () => {
  it("uploads a capture once the view settles in a workspace with no preview", async () => {
    renderHook(() => useWorkspacePreview(options()));
    await flush();
    expect(puts()).toHaveLength(0);

    settle();
    await flush();
    expect(puts()).toEqual([{ method: "PUT", url: "/api/workspaces/ws-1/preview", body: encoded }]);

    // Once per open.
    settle();
    await flush();
    expect(puts()).toHaveLength(1);
    expect(toasts).toEqual([]);
  });

  it("captures when the view settled before the server answered", async () => {
    renderHook(() => useWorkspacePreview(options()));
    settle();
    await flush();
    expect(puts()).toHaveLength(1);
  });

  it("leaves a recent preview alone and refreshes an old one", async () => {
    stored = new Date(Date.now() - 60_000);
    const first = renderHook(() => useWorkspacePreview(options()));
    await flush();
    settle();
    await flush();
    expect(puts()).toHaveLength(0);
    first.unmount();

    stored = new Date(Date.now() - PREVIEW_REFRESH_MS - 60_000);
    renderHook(() => useWorkspacePreview(options()));
    await flush();
    settle();
    await flush();
    expect(puts()).toHaveLength(1);
  });

  it("waits for a run with data in it to end on its own", async () => {
    const hook = renderHook((props: WorkspacePreviewOptions) => useWorkspacePreview(props), {
      initialProps: options({ hasData: false }),
    });
    await flush();
    settle();
    settle("timeout");
    await flush();
    expect(puts()).toHaveLength(0);

    hook.rerender(options({ hasData: true }));
    settle(null);
    settle("explicit");
    await flush();
    expect(puts(), "an opening edge or an export's close is not a settle").toHaveLength(0);

    settle();
    await flush();
    expect(puts()).toHaveLength(1);
  });

  it("takes a run that timed out, for a view that never goes quiet", async () => {
    renderHook(() => useWorkspacePreview(options()));
    await flush();
    settle("timeout");
    await flush();
    expect(puts()).toHaveLength(1);
  });

  it("captures when data lands on a page that had already settled", async () => {
    const hook = renderHook((props: WorkspacePreviewOptions) => useWorkspacePreview(props), {
      initialProps: options({ hasData: false }),
    });
    settle();
    await flush();
    expect(puts()).toHaveLength(0);

    recorder.quiescence = { quiescent: true };
    hook.rerender(options({ hasData: true }));
    await flush();
    expect(puts()).toHaveLength(1);
  });

  it("does not count a page as settled while a run is open", async () => {
    recorder.quiescence = { quiescent: true };
    recorder.isRunOpen = true;
    renderHook(() => useWorkspacePreview(options()));
    await flush();
    expect(puts()).toHaveLength(0);
  });

  it("skips a settle that a new gesture already overtook", async () => {
    renderHook(() => useWorkspacePreview(options()));
    await flush();
    recorder.isRunOpen = true;
    settle();
    await flush();
    expect(puts()).toHaveLength(0);

    recorder.isRunOpen = false;
    settle();
    await flush();
    expect(puts()).toHaveLength(1);
  });

  it("never asks or uploads for someone who may not upload", async () => {
    const result = renderHook(() => useWorkspacePreview(options({ canUpload: false }))).result;
    settle();
    await flush();
    expect(calls).toEqual([]);
    expect(result.current).toBeUndefined();
    expect(runCommand("workspace.useViewAsPreview")).toBe(false);
  });

  it("tries again at the next settle when the canvas was still blank", async () => {
    vi.mocked(encodePreview).mockRejectedValueOnce(new BlankFrameError());
    renderHook(() => useWorkspacePreview(options()));
    settle();
    await flush();
    expect(puts()).toHaveLength(0);

    settle();
    await flush();
    expect(puts()).toHaveLength(1);
  });

  it("stays silent when the capture or the server fails", async () => {
    renderHook(() =>
      useWorkspacePreview(options({ captureFrame: () => Promise.resolve({ frame: null, reason: "no canvas" }) })),
    );
    settle();
    await flush();
    expect(puts()).toHaveLength(0);
    cleanup();

    stored = 500;
    renderHook(() => useWorkspacePreview(options()));
    settle();
    await flush();
    expect(puts()).toHaveLength(0);
    expect(toasts).toEqual([]);
  });
});

describe("useWorkspacePreview, by hand", () => {
  it("uploads the current view and says so", async () => {
    stored = new Date();
    const { result } = renderHook(() => useWorkspacePreview(options()));
    await flush();
    expect(runCommand("workspace.useViewAsPreview")).toBe(true);
    await flush();
    expect(puts()).toHaveLength(1);
    expect(toasts).toEqual([expect.objectContaining({ title: "Preview updated", tone: "success" })]);

    result.current?.();
    await flush();
    expect(puts()).toHaveLength(2);
  });

  it("waits for a moving view to settle first", async () => {
    stored = new Date();
    renderHook(() => useWorkspacePreview(options()));
    await flush();
    recorder.isRunOpen = true;
    runCommand("workspace.useViewAsPreview");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(puts()).toHaveLength(0);

    recorder.isRunOpen = false;
    settle();
    await flush();
    expect(puts()).toHaveLength(1);
  });

  it("keeps the view somebody chose from being replaced automatically", async () => {
    renderHook(() => useWorkspacePreview(options()));
    await flush();
    runCommand("workspace.useViewAsPreview");
    await flush();
    settle();
    await flush();
    expect(puts()).toHaveLength(1);
  });

  it("names the server's refusal in a toast", async () => {
    putStatus = 429;
    renderHook(() => useWorkspacePreview(options()));
    await flush();
    runCommand("workspace.useViewAsPreview");
    await flush();
    expect(toasts).toEqual([
      expect.objectContaining({ title: "Couldn't update the preview", description: "try again in 3 s", tone: "danger" }),
    ]);
  });

  it("is offered only once there is data to show", () => {
    const hook = renderHook((props: WorkspacePreviewOptions) => useWorkspacePreview(props), {
      initialProps: options({ hasData: false }),
    });
    expect(hook.result.current).toBeUndefined();
    expect(runCommand("workspace.useViewAsPreview")).toBe(false);
    hook.rerender(options({ hasData: true }));
    expect(hook.result.current).toBeTypeOf("function");
  });
});
