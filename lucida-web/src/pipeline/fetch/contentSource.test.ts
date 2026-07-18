import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProxiedContentSource, DEFAULT_TIMEOUT_MS } from "./contentSource.ts";
import { FetchError } from "./retry.ts";
import type { FailureDescriptor } from "../../bridge.ts";
import type { FetchRequest } from "./contentSource.ts";

const TRANSIENT_SOURCE_FAILURE: FailureDescriptor = {
  category: "source",
  code: "storage_backend",
  retryable: true,
};

const PERMANENT_SOURCE_FAILURE: FailureDescriptor = {
  category: "authorization",
  code: "permission",
  retryable: false,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let sentMessages: string[];
let source: ProxiedContentSource;

function request(
  datasetId = "ds-1",
  imageId = "image-1",
  chunkKey = "0/0/0/0/0/0",
  expectedResponseBytes = 64,
): FetchRequest {
  return { datasetId, imageId, chunkKey, expectedResponseBytes };
}

beforeEach(() => {
  vi.useFakeTimers();
  sentMessages = [];
  source = new ProxiedContentSource(
    (json) => { sentMessages.push(json); return true; },
    () => {},
  );
  source.registerImage("ds-1", "image-1", { Raw: { data_type: "uint16" } });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Timeout invariant
// ---------------------------------------------------------------------------

describe("DEFAULT_TIMEOUT_MS", () => {
  it("keeps the client timeout above the store's worst-case read budget", () => {
    // Mirror of lucida-store `backend::CLIENT_FETCH_TIMEOUT`; drift on either
    // side must be caught. The documented server read budget is the retry-loop
    // budget (retry_timeout 3s) plus a final per-attempt request timeout
    // (SOURCE_REQUEST_TIMEOUT 5s) = 8s, and the client must keep >= 1s of
    // headroom above it so the client, not the server, wins the timeout race.
    const SERVER_READ_BUDGET_MS = 3_000 + 5_000;
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(SERVER_READ_BUDGET_MS + 1_000);
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(9_000);
  });
});

// ---------------------------------------------------------------------------
// Chunk fetches
// ---------------------------------------------------------------------------

describe("ProxiedContentSource.fetch", () => {
  it("happy path: sendMessage fires, handleChunkData resolves with bytes/wireFormat/dataType", async () => {
    const ctrl = new AbortController();
    const promise = source.fetch(
      request(),
      ctrl.signal,
    );

    expect(sentMessages.length).toBe(1);
    const msg = JSON.parse(sentMessages[0]);
    expect(msg.type).toBe("chunk_request");
    expect(msg.dataset_id).toBe("ds-1");
    expect(msg.image_id).toBe("image-1");
    expect(msg.key).toBe("0/0/0/0/0/0");

    const responseBytes = new Uint8Array([0x10, 0x20, 0x30]).buffer;
    source.handleChunkData("ds-1/image-1/0/0/0/0/0/0", responseBytes);

    const result = await promise;
    expect(result.bytes).toBe(responseBytes);
    expect(result.wireFormat).toEqual({ Raw: { data_type: "uint16" } });
    expect(result.dataType).toBe("uint16");
  });

  it("coalesces duplicate in-flight chunk fetches by wire key", async () => {
    const first = source.fetch(
      request(),
      new AbortController().signal,
    );
    const second = source.fetch(
      request(),
      new AbortController().signal,
    );

    expect(sentMessages).toHaveLength(1);

    const responseBytes = new Uint8Array([0x10, 0x20, 0x30]).buffer;
    source.handleChunkData("ds-1/image-1/0/0/0/0/0/0", responseBytes);

    const [a, b] = await Promise.all([first, second]);
    expect(new Uint8Array(a.bytes)).toEqual(new Uint8Array([0x10, 0x20, 0x30]));
    expect(new Uint8Array(b.bytes)).toEqual(new Uint8Array([0x10, 0x20, 0x30]));
    expect(a.bytes).not.toBe(b.bytes);
  });

  it("scopes a shared image id by dataset through removal and decode routing", async () => {
    const sharedImageId = "shared-image";
    source.registerImage("ds-a", sharedImageId, { Raw: { data_type: "uint8" } });
    source.registerImage("ds-b", sharedImageId, { Raw: { data_type: "uint16" } });
    const reqA = request("ds-a", sharedImageId, "0/0/0/0/0/0");
    const reqB = request("ds-b", sharedImageId, "0/0/0/0/0/0");
    const firstA = source.fetch(reqA, new AbortController().signal);
    const firstB = source.fetch(reqB, new AbortController().signal);
    source.handleChunkData("ds-a/shared-image/0/0/0/0/0/0", new ArrayBuffer(1));
    source.handleChunkData("ds-b/shared-image/0/0/0/0/0/0", new ArrayBuffer(2));

    await expect(firstA).resolves.toMatchObject({
      dataType: "uint8",
      wireFormat: { Raw: { data_type: "uint8" } },
    });
    await expect(firstB).resolves.toMatchObject({
      dataType: "uint16",
      wireFormat: { Raw: { data_type: "uint16" } },
    });

    source.unregisterDataset("ds-a");
    await expect(source.fetch(reqA, new AbortController().signal))
      .rejects.toThrow(/No wire format registered/);

    const survivor = source.fetch(reqB, new AbortController().signal);
    source.handleChunkData("ds-b/shared-image/0/0/0/0/0/0", new ArrayBuffer(2));
    await expect(survivor).resolves.toMatchObject({
      dataType: "uint16",
      wireFormat: { Raw: { data_type: "uint16" } },
    });
  });

  it.each([
    ["same response size", 64],
    ["changed response size", 32],
  ])("awaits a transport epoch before reusing a removed dataset wire key (%s)", async (_name, nextBytes) => {
    let open = true;
    const sent: string[] = [];
    const resetTransport = vi.fn(() => { open = false; });
    const isolated = new ProxiedContentSource(
      (json) => {
        if (!open) return false;
        sent.push(json);
        return true;
      },
      resetTransport,
      100,
      1024,
    );
    isolated.registerImage("ds-reused", "image", { Raw: { data_type: "uint16" } });
    const old = isolated.fetch(
      request("ds-reused", "image", "0/0/0/0/0/0", 64),
      new AbortController().signal,
    );
    expect(sent).toHaveLength(1);

    isolated.rejectDataset("ds-reused");
    isolated.unregisterDataset("ds-reused");
    isolated.registerImage("ds-reused", "image", { Raw: { data_type: "uint8" } });
    await expect(old).rejects.toThrow("Dataset removed");
    expect(resetTransport).toHaveBeenCalledOnce();

    let replacementSettled = false;
    const replacement = isolated.fetch(
      request("ds-reused", "image", "0/0/0/0/0/0", nextBytes),
      new AbortController().signal,
    ).finally(() => { replacementSettled = true; });
    expect(sent).toHaveLength(1);

    // A late response from the removed binding retires only its old credit;
    // it cannot satisfy the new registration's deferred request.
    isolated.handleChunkData("ds-reused/image/0/0/0/0/0/0", new ArrayBuffer(64));
    await Promise.resolve();
    expect(replacementSettled).toBe(false);

    isolated.handleTransportClosed();
    open = true;
    isolated.handleTransportReady();
    expect(sent).toHaveLength(2);
    isolated.handleChunkData(
      "ds-reused/image/0/0/0/0/0/0",
      new ArrayBuffer(nextBytes),
    );
    await expect(replacement).resolves.toMatchObject({
      dataType: "uint8",
      wireFormat: { Raw: { data_type: "uint8" } },
    });
  });

  it("forces an epoch boundary when a live image registration changes codec", async () => {
    let open = true;
    const sent: string[] = [];
    const resetTransport = vi.fn(() => { open = false; });
    const isolated = new ProxiedContentSource(
      (json) => {
        if (!open) return false;
        sent.push(json);
        return true;
      },
      resetTransport,
      100,
      1024,
    );
    isolated.registerImage("ds-codec", "image", { Lz4: { data_type: "uint16" } });
    const old = isolated.fetch(
      request("ds-codec", "image", "0/0/0/0/0/0", 64),
      new AbortController().signal,
    );

    isolated.registerImage("ds-codec", "image", { Zstd: { data_type: "uint16" } });
    await expect(old).rejects.toThrow("registration changed");
    expect(resetTransport).toHaveBeenCalledOnce();
    const replacement = isolated.fetch(
      request("ds-codec", "image", "0/0/0/0/0/0", 64),
      new AbortController().signal,
    );
    isolated.handleChunkData("ds-codec/image/0/0/0/0/0/0", new ArrayBuffer(64));

    isolated.handleTransportClosed();
    open = true;
    isolated.handleTransportReady();
    expect(sent).toHaveLength(2);
    isolated.handleChunkData("ds-codec/image/0/0/0/0/0/0", new ArrayBuffer(64));
    await expect(replacement).resolves.toMatchObject({
      wireFormat: { Zstd: { data_type: "uint16" } },
    });
  });

  it("rejects synchronously when the image's wire format is not registered", async () => {
    const ctrl = new AbortController();
    await expect(
      source.fetch(
        request("ds-1", "unregistered-image"),
        ctrl.signal,
      ),
    ).rejects.toThrow(/No wire format registered for image unregistered-image/);
  });

  it("the unregistered-image rejection is a FetchError with kind: permanent", async () => {
    const ctrl = new AbortController();
    try {
      await source.fetch(
        request("ds-1", "unregistered-image"),
        ctrl.signal,
      );
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(FetchError);
      expect((err as FetchError).kind).toBe("permanent");
      expect((err as FetchError).message).toMatch(/No wire format registered/);
    }
  });

  it("times out after the configured timeoutMs", async () => {
    const fastSource = new ProxiedContentSource(
      (json) => { sentMessages.push(json); return true; },
      () => {},
      50,
    );
    fastSource.registerImage("ds-1", "image-1", { Raw: { data_type: "uint16" } });
    const ctrl = new AbortController();
    const promise = fastSource.fetch(
      request(),
      ctrl.signal,
    );
    vi.advanceTimersByTime(60);
    await expect(promise).rejects.toThrow(/timed out/);
  });

  it("aborts when the signal fires (DOMException AbortError)", async () => {
    const ctrl = new AbortController();
    const promise = source.fetch(
      request(),
      ctrl.signal,
    );
    ctrl.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps disconnect-window requests uncredited and drains them on reconnect", async () => {
    let open = false;
    const sent: string[] = [];
    const attempts: string[] = [];
    const credited = new ProxiedContentSource(
      (json) => {
        attempts.push(json);
        if (!open) return false;
        sent.push(json);
        return true;
      },
      () => {},
      50,
      100,
    );
    credited.registerImage("ds-1", "image-1", { Raw: { data_type: "uint16" } });
    const first = credited.fetch(
      request("ds-1", "image-1", "0/0/0/0/0/0", 60),
      new AbortController().signal,
    );
    const second = credited.fetch(
      request("ds-1", "image-1", "0/0/0/0/0/1", 60),
      new AbortController().signal,
    );

    expect(attempts.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60);
    // Unsent queue time is not a response timeout and owns no response credit.
    expect(sent).toHaveLength(0);

    open = true;
    credited.handleTransportReady();
    expect(sent).toHaveLength(1);
    credited.handleChunkData("ds-1/image-1/0/0/0/0/0/0", new ArrayBuffer(60));
    expect(sent).toHaveLength(2);
    credited.handleChunkData("ds-1/image-1/0/0/0/0/0/1", new ArrayBuffer(60));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("same-key timeout resets the socket epoch before a retry can transmit", async () => {
    const sent: string[] = [];
    let open = true;
    const resetTransport = vi.fn(() => { open = false; });
    const credited = new ProxiedContentSource(
      (json) => {
        if (!open) return false;
        sent.push(json);
        return true;
      },
      resetTransport,
      50,
      100,
    );
    credited.registerImage("ds-1", "image-1", { Raw: { data_type: "uint16" } });
    const req = request("ds-1", "image-1", "0/0/0/0/0/0", 60);
    const first = credited.fetch(req, new AbortController().signal);
    const firstTimedOut = expect(first).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await firstTimedOut;
    expect(resetTransport).toHaveBeenCalledOnce();

    const retry = credited.fetch(req, new AbortController().signal);
    expect(sent).toHaveLength(1); // joined old epoch; no overlapping resend

    // The bridge's disconnect callback is the definitive terminal. It releases
    // old response credit and settles the joined retry.
    credited.rejectAll();
    await expect(retry).rejects.toThrow(/Bridge disconnected/);

    const afterReconnect = credited.fetch(req, new AbortController().signal);
    expect(sent).toHaveLength(1);
    open = true;
    credited.handleTransportReady();
    expect(sent).toHaveLength(2);
    credited.handleChunkData("ds-1/image-1/0/0/0/0/0/0", new ArrayBuffer(60));
    await expect(afterReconnect).resolves.toMatchObject({ dataType: "uint16" });
  });

  it("retains sent response credit across local abort until a timely late frame arrives", async () => {
    const sent: string[] = [];
    const resetTransport = vi.fn();
    const credited = new ProxiedContentSource(
      (json) => { sent.push(json); return true; },
      resetTransport,
      50,
      100,
    );
    credited.registerImage("ds-1", "image-1", { Raw: { data_type: "uint16" } });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = credited.fetch(request("ds-1", "image-1", "0/0/0/0/0/0", 60), firstController.signal);
    const second = credited.fetch(request("ds-1", "image-1", "0/0/0/0/0/1", 60), secondController.signal);

    expect(sent).toHaveLength(1);
    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(sent).toHaveLength(1);

    // Cancellation settles the waiter but does not free credit or send the
    // queued request. A response before the original deadline owns that
    // release and avoids resetting the transport.
    await vi.advanceTimersByTimeAsync(40);
    expect(sent).toHaveLength(1);
    expect(resetTransport).not.toHaveBeenCalled();

    credited.handleChunkData("ds-1/image-1/0/0/0/0/0/0", new ArrayBuffer(60));
    expect(sent).toHaveLength(2);
    credited.handleChunkData("ds-1/image-1/0/0/0/0/0/1", new ArrayBuffer(60));
    await expect(second).resolves.toMatchObject({ dataType: "uint16" });
  });

  it("keeps a transport deadline after the last waiter aborts", async () => {
    const sent: string[] = [];
    let open = true;
    const resetTransport = vi.fn(() => { open = false; });
    const credited = new ProxiedContentSource(
      (json) => {
        if (!open) return false;
        sent.push(json);
        return true;
      },
      resetTransport,
      50,
      100,
    );
    credited.registerImage("ds-1", "image-1", { Raw: { data_type: "uint16" } });
    const firstController = new AbortController();
    const first = credited.fetch(
      request("ds-1", "image-1", "0/0/0/0/0/0", 60),
      firstController.signal,
    );
    const queued = credited.fetch(
      request("ds-1", "image-1", "0/0/0/0/0/1", 60),
      new AbortController().signal,
    );

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(60);

    expect(resetTransport).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    // Reset initiation alone cannot release old-epoch credit. The bridge's
    // disconnect callback is the sole release and settles queued work once.
    credited.handleTransportReady();
    expect(sent).toHaveLength(1);
    credited.rejectAll();
    await expect(queued).rejects.toThrow(/Bridge disconnected/);
  });

  it("keeps a transport deadline after dataset removal leaves a sent tombstone", async () => {
    const sent: string[] = [];
    let open = true;
    const resetTransport = vi.fn(() => { open = false; });
    const credited = new ProxiedContentSource(
      (json) => {
        if (!open) return false;
        sent.push(json);
        return true;
      },
      resetTransport,
      50,
      100,
    );
    credited.registerImage("ds-a", "image-1", { Raw: { data_type: "uint16" } });
    credited.registerImage("ds-b", "image-1", { Raw: { data_type: "uint16" } });
    const removed = credited.fetch(
      request("ds-a", "image-1", "0/0/0/0/0/0", 60),
      new AbortController().signal,
    );
    const survivor = credited.fetch(
      request("ds-b", "image-1", "0/0/0/0/0/0", 60),
      new AbortController().signal,
    );

    credited.rejectDataset("ds-a");
    await expect(removed).rejects.toThrow(/Dataset removed/);
    await vi.advanceTimersByTimeAsync(60);

    expect(resetTransport).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    credited.rejectAll();
    await expect(survivor).rejects.toThrow(/Bridge disconnected/);
  });

  it("retains response credit after a local timeout until transport terminal", async () => {
    const sent: string[] = [];
    const resetTransport = vi.fn();
    const credited = new ProxiedContentSource(
      (json) => { sent.push(json); return true; },
      resetTransport,
      50,
      100,
    );
    credited.registerImage("ds-1", "image-1", { Raw: { data_type: "uint16" } });
    const first = credited.fetch(
      request("ds-1", "image-1", "0/0/0/0/0/0", 60),
      new AbortController().signal,
    );
    const second = credited.fetch(
      request("ds-1", "image-1", "0/0/0/0/0/1", 60),
      new AbortController().signal,
    );
    expect(sent).toHaveLength(1);

    const firstTimedOut = expect(first).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await firstTimedOut;
    expect(sent).toHaveLength(1);
    expect(resetTransport).toHaveBeenCalledOnce();

    credited.handleSourceChunkStatus(
      "ds-1",
      "image-1",
      "0/0/0/0/0/0",
      "unavailable",
      TRANSIENT_SOURCE_FAILURE,
    );
    expect(sent).toHaveLength(2);
    credited.handleChunkData("ds-1/image-1/0/0/0/0/0/1", new ArrayBuffer(60));
    await expect(second).resolves.toMatchObject({ dataType: "uint16" });
  });

  it("rejectDataset cancels pending requests for that dataset only", async () => {
    const ctrl = new AbortController();
    source.registerImage("ds-2", "image-1", { Raw: { data_type: "uint16" } });
    const p1 = source.fetch(
      request(),
      ctrl.signal,
    );
    const p2 = source.fetch(
      request("ds-2"),
      ctrl.signal,
    );

    source.rejectDataset("ds-1");

    await expect(p1).rejects.toThrow(/Dataset removed/);
    // p2 should still be pending — resolve it to confirm.
    source.handleChunkData("ds-2/image-1/0/0/0/0/0/0", new ArrayBuffer(8));
    await expect(p2).resolves.toMatchObject({ dataType: "uint16" });
  });

  it("rejectAll cancels every pending chunk request", async () => {
    const ctrl = new AbortController();
    const chunkPromise = source.fetch(
      request(),
      ctrl.signal,
    );
    source.rejectAll();

    await expect(chunkPromise).rejects.toThrow(/Bridge disconnected/);
  });

  it("generated pending status rejects with FetchError kind pending", async () => {
    const ctrl = new AbortController();
    const promise = source.fetch(
      request("ds-1", "image-1", "2/0/0/0/0/0"),
      ctrl.signal,
    );

    source.handleChunkStatus("ds-1", "image-1", "2/0/0/0/0/0", "pending");

    try {
      await promise;
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(FetchError);
      expect((err as FetchError).kind).toBe("pending");
    }
  });

  it("generated statuses map unavailable/permanent/transient distinctly", async () => {
    const statuses = [
      ["unavailable", "permanent"],
      ["failed_permanent", "permanent"],
      ["failed_transient", "transient"],
    ] as const;

    for (const [status, kind] of statuses) {
      const ctrl = new AbortController();
      const chunkKey = `2/0/0/0/0/${status.length}`;
      const promise = source.fetch(
        request("ds-1", "image-1", chunkKey),
        ctrl.signal,
      );
      source.handleChunkStatus(
        "ds-1",
        "image-1",
        chunkKey,
        status,
        kind === "transient" ? TRANSIENT_SOURCE_FAILURE : PERMANENT_SOURCE_FAILURE,
        "test",
      );

      await expect(promise).rejects.toMatchObject({
        kind,
        failure: kind === "transient" ? TRANSIENT_SOURCE_FAILURE : PERMANENT_SOURCE_FAILURE,
      });
    }
  });

  it("a server source-chunk status classifies failed_permanent as permanent and unavailable as transient", async () => {
    // The server only reports store failures here (not-found is served as
    // zero-filled bytes). A revoked-access/credentials failure sticks
    // (`permanent`); a backend fault / throttle / timeout must self-heal
    // (`transient`) instead of dark-holing the chunk until reopen — the
    // server now emits `unavailable` when its bounded retry budget is spent
    // before the client's own fetch timeout would fire.
    const cases = [
      ["failed_permanent", "permanent"],
      ["unavailable", "transient"],
    ] as const;

    for (const [status, kind] of cases) {
      const ctrl = new AbortController();
      const chunkKey = `2/0/0/0/1/${status.length}`;
      const promise = source.fetch(
        request("ds-1", "image-1", chunkKey),
        ctrl.signal,
      );
      source.handleSourceChunkStatus(
        "ds-1",
        "image-1",
        chunkKey,
        status,
        kind === "transient" ? TRANSIENT_SOURCE_FAILURE : PERMANENT_SOURCE_FAILURE,
        "store rejected the read",
      );

      await expect(promise).rejects.toMatchObject({
        name: "FetchError",
        kind,
        failure: kind === "transient" ? TRANSIENT_SOURCE_FAILURE : PERMANENT_SOURCE_FAILURE,
        message: expect.stringContaining("store rejected the read"),
      });
    }
  });

  it("a source-chunk status rejects every coalesced waiter and clears the pending slot", async () => {
    const ctrl = new AbortController();
    const req = request("ds-1", "image-1", "2/0/0/0/0/0");
    const first = source.fetch(req, ctrl.signal);
    const second = source.fetch(req, ctrl.signal);

    source.handleSourceChunkStatus(
      "ds-1",
      "image-1",
      "2/0/0/0/0/0",
      "unavailable",
      TRANSIENT_SOURCE_FAILURE,
    );
    await expect(first).rejects.toMatchObject({ kind: "transient" });
    await expect(second).rejects.toMatchObject({ kind: "transient" });

    // The slot was consumed: a re-fetch sends a fresh chunk_request.
    const framesBefore = sentMessages.length;
    void source.fetch(req, ctrl.signal).catch(() => {});
    expect(sentMessages.length).toBe(framesBefore + 1);
  });

  it("a source-chunk status with no pending fetch is a no-op", () => {
    expect(() =>
      source.handleSourceChunkStatus(
        "ds-1",
        "image-1",
        "9/9/9/9/9/9",
        "failed_permanent",
        PERMANENT_SOURCE_FAILURE,
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// handleBinary dispatch
// ---------------------------------------------------------------------------

describe("ProxiedContentSource.handleBinary", () => {
  it("routes a binary response to the chunk queue", async () => {
    const ctrl = new AbortController();
    const promise = source.fetch(
      request(),
      ctrl.signal,
    );

    const responseBytes = new Uint8Array([0x10, 0x20, 0x30]).buffer;
    source.handleBinary("ds-1/image-1/0/0/0/0/0/0", responseBytes);

    const result = await promise;
    expect(result.bytes).toBe(responseBytes);
    expect(result.dataType).toBe("uint16");
  });
});
