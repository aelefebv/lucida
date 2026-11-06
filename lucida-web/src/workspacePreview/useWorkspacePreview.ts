import { useCallback, useEffect, useRef } from "react";
import type { FrameCaptureResult } from "../renderer/workerProtocol.ts";
import { traceRecorder } from "../trace/recorder.ts";
import { useCommand } from "../ui/commands.ts";
import { toast } from "../ui/toastQueue.ts";
import { fetchPreviewUpdatedAt, uploadPreview } from "./api.ts";
import { BlankFrameError, encodePreview } from "./encode.ts";

/** How old a preview gets before opening the workspace refreshes it. */
export const PREVIEW_REFRESH_MS = 60 * 60 * 1000;

/** How long the explicit command waits for a moving view to settle before it takes what is there. */
const SETTLE_WAIT_MS = 10_000;

export interface WorkspacePreviewOptions {
  workspaceId: string;
  /** Owners and editors, and never the capture surface, which writes nothing. */
  canUpload: boolean;
  hasData: boolean;
  /** Ask for the frame on the canvas; null before a render client exists. */
  captureFrame: () => Promise<FrameCaptureResult> | null;
}

/** Whether an open should capture, given when the stored preview was written. */
export function previewWanted(updatedAt: Date | null, now: number): boolean {
  return updatedAt === null || now - updatedAt.getTime() >= PREVIEW_REFRESH_MS;
}

/**
 * Whether the page is settled now: no run open, and the last published
 * quiescence holds. For a check made between boundaries, such as data
 * appearing after the run that brought it had already closed.
 */
function settledNow(): boolean {
  return !traceRecorder.isRunOpen && traceRecorder.quiescence?.quiescent === true;
}

/** Run `work` when the page is idle, so the capture never competes with a frame. */
function whenIdle(work: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(work, { timeout: 2000 });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(work, 200);
  return () => clearTimeout(handle);
}

/** Resolve once the run in progress ends, at once when none is open, or after `timeoutMs`. */
function untilSettled(timeoutMs: number): Promise<void> {
  if (!traceRecorder.isRunOpen) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    // A boundary listener runs inside the recorder's close, so leave it before acting.
    const unsubscribe = traceRecorder.onRunBoundary((boundary) => {
      if (boundary.endReason !== null) queueMicrotask(finish);
    });
  });
}

async function capturePreview(captureFrame: WorkspacePreviewOptions["captureFrame"]): Promise<Blob> {
  const pending = captureFrame();
  if (!pending) throw new Error("the viewer has not drawn anything yet");
  const result = await pending;
  if (!result.frame) throw new Error(result.reason);
  return encodePreview(result.frame.png);
}

/**
 * Keep the workspace's dashboard preview current, from what this viewer
 * renders.
 *
 * Once per open, after the view first settles with data in it, an owner or
 * editor uploads a capture if the workspace has no preview or its preview
 * is over an hour old. "Settled" is the trace's quiescence: a run closing
 * because everything the view asked for is resident, so the capture shows
 * full detail rather than whatever had arrived. A run that times out counts
 * too, so a view that never goes quiet still gets a preview. Failures stay
 * silent.
 *
 * Also registers "Use this view as the preview", and returns it for the
 * workspace menu, or undefined while it is not available.
 */
export function useWorkspacePreview(options: WorkspacePreviewOptions): (() => void) | undefined {
  const { workspaceId, canUpload, hasData } = options;
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  // Nothing automatic replaces a view somebody chose by hand.
  const chosenByHand = useRef(false);
  const explicitBusy = useRef(false);
  // Set by the effect below: count the page as settled if it already is.
  const checkSettled = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!canUpload) return;
    chosenByHand.current = false;
    let disposed = false;
    let done = false;
    let wanted: boolean | null = null;
    let viewSettled = false;
    let cancelIdle: (() => void) | null = null;

    const attempt = () => {
      if (disposed || done || chosenByHand.current || !wanted || !viewSettled || cancelIdle) return;
      cancelIdle = whenIdle(() => {
        cancelIdle = null;
        if (disposed || chosenByHand.current) return;
        // Somebody moved since the view settled; wait for this run to close too.
        if (traceRecorder.isRunOpen) {
          viewSettled = false;
          return;
        }
        done = true;
        viewSettled = false;
        capturePreview(latest.current.captureFrame)
          .then((image) => uploadPreview(workspaceId, image))
          .catch((e: unknown) => {
            // A blank canvas settles again once something draws. Anything
            // else stays silent until the next open: a preview is a nicety.
            if (e instanceof BlankFrameError) done = false;
          });
      });
    };

    const unsubscribe = traceRecorder.onRunBoundary((boundary) => {
      const ended = boundary.endReason === "quiescent" || boundary.endReason === "timeout";
      if (!ended || !latest.current.hasData) return;
      viewSettled = true;
      attempt();
    });
    checkSettled.current = () => {
      if (latest.current.hasData && settledNow()) viewSettled = true;
      attempt();
    };
    fetchPreviewUpdatedAt(workspaceId).then(
      (updatedAt) => {
        wanted = previewWanted(updatedAt, Date.now());
        checkSettled.current?.();
      },
      () => {
        wanted = false;
      },
    );
    return () => {
      disposed = true;
      checkSettled.current = null;
      unsubscribe();
      cancelIdle?.();
    };
  }, [workspaceId, canUpload]);

  // Data can land after the run that brought it closed; the boundary saw none.
  useEffect(() => {
    if (hasData) checkSettled.current?.();
  }, [hasData]);

  const takeViewAsPreview = useCallback(async () => {
    if (explicitBusy.current) return;
    explicitBusy.current = true;
    chosenByHand.current = true;
    try {
      await untilSettled(SETTLE_WAIT_MS);
      const image = await capturePreview(latest.current.captureFrame);
      await uploadPreview(workspaceId, image);
      toast({ title: "Preview updated", description: "The dashboard shows this view for the workspace.", tone: "success" });
    } catch (e) {
      toast({
        title: "Couldn't update the preview",
        description: e instanceof Error ? e.message : String(e),
        tone: "danger",
      });
    } finally {
      explicitBusy.current = false;
    }
  }, [workspaceId]);

  const available = canUpload && hasData;
  useCommand({
    id: "workspace.useViewAsPreview",
    label: "Use this view as the preview",
    group: "General",
    keywords: ["thumbnail", "snapshot", "dashboard", "card", "image"],
    run: () => void takeViewAsPreview(),
    enabled: available,
  });

  return available ? () => void takeViewAsPreview() : undefined;
}
