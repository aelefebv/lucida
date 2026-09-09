// @vitest-environment happy-dom
/**
 * **Send report**, from the page's side: what the action sends, and what
 * nothing else does.
 *
 * The first case is the one the feature turns on. A run opening,
 * settling and being read is the whole ordinary life of the recorder,
 * and none of it may put a byte outside the page. Everything after it is
 * about the action itself: it serialises once, it refuses a bundle the
 * inbox would refuse, and it says what to do instead when there is no
 * session to send over.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendReport } from "../monitor/monitorSource.ts";
import { setBundleServices } from "./bundle.ts";
import { createQuiescenceState } from "./quiescence.ts";
import { traceRecorder } from "./recorder.ts";
import { MAX_BUNDLE_BYTES, sendBundle, setReportSender } from "./reportInbox.ts";
import { installTraceSeam } from "./seam.ts";

const OPEN_CAUSE = { epoch: "content", dirtyKind: "interactive", source: "dataset_added" } as const;

const RECEIPT = { entryId: "5d1f0c2e-7b3a", expiresAt: "2026-09-23T14:05:00Z" };

/**
 * What the render loop registers. A run cannot open without one, and
 * this test is about a run opening and closing without a send.
 */
function registerEnvironment(): void {
  traceRecorder.setEnvironment({
    captureWarmth: () => ({
      detailChunks: 0,
      detailBytes: 0,
      coarseChunks: 0,
      coarseBytes: 0,
      proxyBytes: 0,
    }),
    captureConditions: () => ({
      datasetIds: ["ds"],
      composedView: { url: "/w/ws-1", mode: "slice" },
      devicePixelRatio: 2,
      viewport: { cssWidth: 800, cssHeight: 600, deviceWidth: 1600, deviceHeight: 1200 },
    }),
    captureOutstanding: () => createQuiescenceState(),
  });
}

describe("Send report", () => {
  beforeEach(() => {
    traceRecorder.reset();
    registerEnvironment();
    // No viewer services: a bundle from a page with none still assembles
    // and says what is missing, which is enough to have something to send.
    setBundleServices(null);
    setReportSender(null);
    // The seam is a page-lifetime global too, and one case is about a
    // page that has none.
    delete window.lucidaTrace;
  });

  /**
   * The invariant the inbox is built on (ADR 0049 as amended): the
   * recording leaves the page when somebody asks, and at no other time.
   */
  it("sends nothing while a run opens, closes and is read — and sends when the action does", async () => {
    const sender = vi.fn(() => Promise.resolve(RECEIPT));
    setReportSender(sender);
    const seam = installTraceSeam();

    traceRecorder.openRun(OPEN_CAUSE);
    traceRecorder.noteFrameDispatched();
    traceRecorder.closeRun("quiescent");
    expect(sender).not.toHaveBeenCalled();

    // Reading the run, and saving the bundle the action would send, are
    // both exports. Neither posts anything.
    seam.exportTrace();
    await seam.exportBundle();
    expect(sender).not.toHaveBeenCalled();

    await expect(sendReport(undefined, seam)).resolves.toStrictEqual(RECEIPT);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("hands the sender the bundle as text, and that text is the bundle", async () => {
    const sender = vi.fn(() => Promise.resolve(RECEIPT));
    const bundle = { format: "lucida-trace-bundle", header: { runId: "remote-cold" } };

    await expect(sendBundle(bundle, sender)).resolves.toStrictEqual(RECEIPT);
    const [bundleJson] = sender.mock.calls[0] as unknown as [string];
    expect(typeof bundleJson).toBe("string");
    expect(JSON.parse(bundleJson)).toStrictEqual(bundle);
  });

  /**
   * The page holds the server's limit so meeting it is a sentence with
   * the bundle still in the browser, rather than megabytes over the
   * socket and a refusal at the other end.
   */
  it("refuses a bundle over the inbox's limit without sending it", async () => {
    const sender = vi.fn(() => Promise.resolve(RECEIPT));
    const oversized = { padding: "x".repeat(MAX_BUNDLE_BYTES) };

    await expect(sendBundle(oversized, sender)).rejects.toThrow(/over the inbox's 8\.0 MB limit/);
    expect(sender).not.toHaveBeenCalled();
  });

  it("says to save the bundle instead when the page has no session to send over", async () => {
    installTraceSeam();
    await expect(sendReport()).rejects.toThrow(/save the bundle to a file/);
  });

  it("fails when there is no seam on the page, rather than sending an empty report", async () => {
    const sender = vi.fn(() => Promise.resolve(RECEIPT));
    setReportSender(sender);
    delete window.lucidaTrace;

    await expect(sendReport()).rejects.toThrow("no trace seam on this page");
    expect(sender).not.toHaveBeenCalled();
  });
});
