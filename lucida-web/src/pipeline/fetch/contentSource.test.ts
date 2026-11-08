import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProxiedContentSource, DEFAULT_TIMEOUT_MS } from "./contentSource.ts";
import { FetchError } from "./retry.ts";

let sentMessages: string[];
let source: ProxiedContentSource;

beforeEach(() => {
  vi.useFakeTimers();
  sentMessages = [];
  source = new ProxiedContentSource((json) => sentMessages.push(json));
  source.registerImage("image-1", { Raw: { data_type: "uint16" } });
});

afterEach(() => {
  vi.useRealTimers();
});

// Timeout invariant

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

// Chunk fetches

describe("ProxiedContentSource.fetch", () => {
  it("happy path: sendMessage fires, handleBinary resolves with bytes/wireFormat/dataType", async () => {
    const ctrl = new AbortController();
    const promise = source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" },
      ctrl.signal,
    );

    expect(sentMessages.length).toBe(1);
    const msg = JSON.parse(sentMessages[0]);
    expect(msg.type).toBe("chunk_request");
    expect(msg.dataset_id).toBe("ds-1");
    expect(msg.image_id).toBe("image-1");
    expect(msg.key).toBe("0/0/0/0/0/0");

    const responseBytes = new Uint8Array([0x10, 0x20, 0x30]).buffer;
    source.handleBinary("ds-1/image-1/0/0/0/0/0/0", responseBytes);

    const result = await promise;
    expect(result.bytes).toBe(responseBytes);
    expect(result.wireFormat).toEqual({ Raw: { data_type: "uint16" } });
    expect(result.dataType).toBe("uint16");
  });

  it("coalesces duplicate in-flight chunk fetches by wire key", async () => {
    const first = source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" },
      new AbortController().signal,
    );
    const second = source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" },
      new AbortController().signal,
    );

    expect(sentMessages).toHaveLength(1);

    const responseBytes = new Uint8Array([0x10, 0x20, 0x30]).buffer;
    source.handleBinary("ds-1/image-1/0/0/0/0/0/0", responseBytes);

    const [a, b] = await Promise.all([first, second]);
    expect(new Uint8Array(a.bytes)).toEqual(new Uint8Array([0x10, 0x20, 0x30]));
    expect(new Uint8Array(b.bytes)).toEqual(new Uint8Array([0x10, 0x20, 0x30]));
    expect(a.bytes).not.toBe(b.bytes);
  });

  it("labels each wire request from one connection counter", () => {
    const labels: number[] = [];
    source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" },
      new AbortController().signal,
      label => labels.push(label.rid),
    );
    source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/1" },
      new AbortController().signal,
      label => labels.push(label.rid),
    );

    expect(labels).toEqual([0, 1]);
    expect(sentMessages.map(m => JSON.parse(m).rid)).toEqual([0, 1]);
  });

  it("gives every coalesced caller the first sender's label", () => {
    const labels: number[] = [];
    const req = { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" };
    source.fetch(req, new AbortController().signal, l => labels.push(l.rid));
    source.fetch(req, new AbortController().signal, l => labels.push(l.rid));
    source.fetch(req, new AbortController().signal, l => labels.push(l.rid));

    expect(sentMessages).toHaveLength(1);
    // Three rows, one wire request, one label: the join stays a plain
    // equi-join and the coalescing count is a group-by over it.
    expect(labels).toEqual([0, 0, 0]);
  });

  it("restarts the counter per connection and stamps the generation", async () => {
    const labels: { rid: number; connectionGeneration: number }[] = [];
    source.resetConnection(1);
    const dropped = source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" },
      new AbortController().signal,
      l => labels.push(l),
    );
    source.rejectAll();
    await expect(dropped).rejects.toThrow("Bridge disconnected");

    source.resetConnection(2);
    source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" },
      new AbortController().signal,
      l => labels.push(l),
    );

    // The same rid either side of a reconnect: only the generation tells
    // the two requests apart.
    expect(labels).toEqual([
      { rid: 0, connectionGeneration: 1 },
      { rid: 0, connectionGeneration: 2 },
    ]);
  });

  it("keeps the label with the group when one coalesced caller leaves", async () => {
    const labels: number[] = [];
    const req = { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" };
    const leaving = new AbortController();
    const first = source.fetch(req, leaving.signal, l => labels.push(l.rid));
    source.fetch(req, new AbortController().signal, l => labels.push(l.rid));

    leaving.abort();
    await expect(first).rejects.toThrow();

    // The wire request the departed caller sent is still in flight, so a
    // late joiner points at it rather than minting a second label for bytes
    // nobody is going to ask for again.
    source.fetch(req, new AbortController().signal, l => labels.push(l.rid));
    expect(sentMessages).toHaveLength(1);
    expect(labels).toEqual([0, 0, 0]);
  });

  it("rejects synchronously when the image's wire format is not registered", async () => {
    const ctrl = new AbortController();
    await expect(
      source.fetch(
        { datasetId: "ds-1", imageId: "unregistered-image", chunkKey: "0/0/0/0/0/0" },
        ctrl.signal,
      ),
    ).rejects.toThrow(/No wire format registered for image unregistered-image/);
  });

  it("the unregistered-image rejection is a FetchError with kind: permanent", async () => {
    const ctrl = new AbortController();
    try {
      await source.fetch(
        { datasetId: "ds-1", imageId: "unregistered-image", chunkKey: "0/0/0/0/0/0" },
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
    const fastSource = new ProxiedContentSource((json) => sentMessages.push(json), 50);
    fastSource.registerImage("image-1", { Raw: { data_type: "uint16" } });
    const ctrl = new AbortController();
    const promise = fastSource.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" },
      ctrl.signal,
    );
    vi.advanceTimersByTime(60);
    await expect(promise).rejects.toThrow(/timed out/);
  });

  it("aborts when the signal fires (DOMException AbortError)", async () => {
    const ctrl = new AbortController();
    const promise = source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" },
      ctrl.signal,
    );
    ctrl.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejectDataset cancels pending requests for that dataset only", async () => {
    const ctrl = new AbortController();
    const p1 = source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" },
      ctrl.signal,
    );
    const p2 = source.fetch(
      { datasetId: "ds-2", imageId: "image-1", chunkKey: "0/0/0/0/0/0" },
      ctrl.signal,
    );

    source.rejectDataset("ds-1");

    await expect(p1).rejects.toThrow(/Dataset removed/);
    // p2 should still be pending — resolve it to confirm.
    source.handleBinary("ds-2/image-1/0/0/0/0/0/0", new ArrayBuffer(8));
    await expect(p2).resolves.toMatchObject({ dataType: "uint16" });
  });

  it("rejectAll cancels every pending chunk request", async () => {
    const ctrl = new AbortController();
    const chunkPromise = source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" },
      ctrl.signal,
    );

    source.rejectAll();

    await expect(chunkPromise).rejects.toThrow(/Bridge disconnected/);
  });

  it("generated pending status rejects with FetchError kind pending", async () => {
    const ctrl = new AbortController();
    const promise = source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "2/0/0/0/0/0" },
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
        { datasetId: "ds-1", imageId: "image-1", chunkKey },
        ctrl.signal,
      );
      source.handleChunkStatus("ds-1", "image-1", chunkKey, status, "test");

      await expect(promise).rejects.toMatchObject({ kind });
    }
  });

  it("a server source-chunk status classifies failed_permanent as permanent and unavailable as transient", async () => {
    // The server only reports store failures here (not-found is served as
    // zero-filled bytes). A revoked-access/credentials failure sticks
    // (`permanent`); a backend fault / throttle / timeout must self-heal
    // (`transient`) instead of dark-holing the chunk until reopen.
    const cases = [
      ["failed_permanent", "permanent"],
      ["unavailable", "transient"],
    ] as const;

    for (const [status, kind] of cases) {
      const ctrl = new AbortController();
      const chunkKey = `2/0/0/0/1/${status.length}`;
      const promise = source.fetch(
        { datasetId: "ds-1", imageId: "image-1", chunkKey },
        ctrl.signal,
      );
      source.handleSourceChunkStatus(
        "ds-1",
        "image-1",
        chunkKey,
        status,
        "store rejected the read",
      );

      await expect(promise).rejects.toMatchObject({
        name: "FetchError",
        kind,
        message: expect.stringContaining("store rejected the read"),
      });
    }
  });

  it("a source-chunk status names the server's reason, and a frame without one names its status", async () => {
    const ctrl = new AbortController();
    const named = source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "1/0/0/0/0/0" },
      ctrl.signal,
    );
    source.handleSourceChunkStatus(
      "ds-1",
      "image-1",
      "1/0/0/0/0/0",
      "failed_permanent",
      "decoded 2 bytes where the stored chunk shape holds 4",
      "wrong_size",
    );
    await expect(named).rejects.toMatchObject({
      kind: "permanent",
      serverReported: true,
      failure: "wrong_size",
      message:
        "Source chunk 1/0/0/0/0/0 decoded to the wrong size: " +
        "decoded 2 bytes where the stored chunk shape holds 4",
    });

    const unnamed = source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "1/0/0/0/0/1" },
      ctrl.signal,
    );
    source.handleSourceChunkStatus("ds-1", "image-1", "1/0/0/0/0/1", "unavailable");
    await expect(unnamed).rejects.toMatchObject({
      kind: "transient",
      failure: null,
      message: "Source chunk 1/0/0/0/0/1 is unavailable",
    });
  });

  it("a source-chunk status rejects every coalesced waiter and clears the pending slot", async () => {
    const ctrl = new AbortController();
    const request = { datasetId: "ds-1", imageId: "image-1", chunkKey: "2/0/0/0/0/0" };
    const first = source.fetch(request, ctrl.signal);
    const second = source.fetch(request, ctrl.signal);

    source.handleSourceChunkStatus("ds-1", "image-1", "2/0/0/0/0/0", "unavailable");
    await expect(first).rejects.toMatchObject({ kind: "transient" });
    await expect(second).rejects.toMatchObject({ kind: "transient" });

    // The slot was consumed: a re-fetch sends a fresh chunk_request.
    const framesBefore = sentMessages.length;
    void source.fetch(request, ctrl.signal).catch(() => {});
    expect(sentMessages.length).toBe(framesBefore + 1);
  });

  it("a source-chunk status with no pending fetch is a no-op", () => {
    expect(() =>
      source.handleSourceChunkStatus("ds-1", "image-1", "9/9/9/9/9/9", "failed_permanent"),
    ).not.toThrow();
  });
});


// handleBinary dispatch

describe("ProxiedContentSource.handleBinary", () => {
  it("resolves the pending chunk fetch under its key", async () => {
    const ctrl = new AbortController();
    const promise = source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" },
      ctrl.signal,
    );

    const responseBytes = new Uint8Array([0x10, 0x20, 0x30]).buffer;
    source.handleBinary("ds-1/image-1/0/0/0/0/0/0", responseBytes);

    const result = await promise;
    expect(result.bytes).toBe(responseBytes);
    expect(result.dataType).toBe("uint16");
  });
});
