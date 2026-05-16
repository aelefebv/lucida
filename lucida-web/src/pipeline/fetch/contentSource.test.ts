/**
 * Tests for ProxiedContentSource.
 *
 * Exercises the full fetch / fetchProxy flow against the
 * sendMessage callback boundary: each test feeds responses back via
 * handleChunkData / handleProxyData (mirroring the bridge's binary
 * routing) and asserts the promise resolution shape.
 *
 * Pinned behaviours include the "No wire format registered" rejection
 * (raised as a typed permanent FetchError) and the 64-byte-header
 * proxy payload contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProxiedContentSource } from "./contentSource.ts";
import { proxyResponseKey } from "./wireProtocol.ts";
import { FetchError } from "./retry.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a 64-byte header buffer plus optional payload. */
function makeProxyResponse(opts?: {
  dims?: [number, number, number];
  payloadBytes?: number;
  badMagic?: boolean;
}): ArrayBuffer {
  const payloadBytes = opts?.payloadBytes ?? 16;
  const buf = new ArrayBuffer(64 + payloadBytes);
  const view = new DataView(buf);
  if (opts?.badMagic) {
    view.setUint8(0, 0x00);
  } else {
    view.setUint8(0, 0x4c); // 'L'
    view.setUint8(1, 0x50); // 'P'
    view.setUint8(2, 0x52); // 'R'
    view.setUint8(3, 0x58); // 'X'
  }
  view.setUint32(4, 1, true); // algorithmVersion
  const dims = opts?.dims ?? [2, 2, 2];
  view.setUint32(8, dims[0], true);
  view.setUint32(12, dims[1], true);
  view.setUint32(16, dims[2], true);
  view.setUint32(20, 0, true); // dtype = u16
  // Hash bytes left at zero.
  // Fill payload with a recognizable byte so callers can assert it.
  new Uint8Array(buf, 64).fill(0xAB);
  return buf;
}

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

// ---------------------------------------------------------------------------
// Chunk fetches
// ---------------------------------------------------------------------------

describe("ProxiedContentSource.fetch", () => {
  it("happy path: sendMessage fires, handleChunkData resolves with bytes/wireFormat/dataType", async () => {
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
    source.handleChunkData("ds-1/image-1/0/0/0/0/0/0", responseBytes);

    const result = await promise;
    expect(result.bytes).toBe(responseBytes);
    expect(result.wireFormat).toEqual({ Raw: { data_type: "uint16" } });
    expect(result.dataType).toBe("uint16");
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
    // Substring-only classification would treat this as transient
    // (matches neither "404" nor "malformed"), wasting a retry on a
    // setup bug. The typed FetchError lets the source own
    // classification; the cache dispatches via `classifyFetchError`.
    // Locked here so a future change can't silently regress.
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
    source.handleChunkData("ds-2/image-1/0/0/0/0/0/0", new ArrayBuffer(8));
    await expect(p2).resolves.toMatchObject({ dataType: "uint16" });
  });

  it("rejectAll cancels every pending chunk and proxy request", async () => {
    const ctrl = new AbortController();
    const chunkPromise = source.fetch(
      { datasetId: "ds-1", imageId: "image-1", chunkKey: "0/0/0/0/0/0" },
      ctrl.signal,
    );
    const proxyPromise = source.fetchProxy(
      { datasetId: "ds-1", entityId: "ent-1", kind: "WellProxy3D", t: 0, c: 0 },
      ctrl.signal,
    );

    source.rejectAll();

    await expect(chunkPromise).rejects.toThrow(/Bridge disconnected/);
    await expect(proxyPromise).rejects.toThrow(/Bridge disconnected/);
  });
});

// ---------------------------------------------------------------------------
// Proxy fetches
// ---------------------------------------------------------------------------

describe("ProxiedContentSource.fetchProxy", () => {
  it("happy path: sends asset_request; handleProxyData decodes header + slices payload", async () => {
    const ctrl = new AbortController();
    const promise = source.fetchProxy(
      { datasetId: "ds-1", entityId: "ent-1", kind: "WellProxy3D", t: 0, c: 0 },
      ctrl.signal,
    );

    expect(sentMessages.length).toBe(1);
    const msg = JSON.parse(sentMessages[0]);
    expect(msg.type).toBe("asset_request");
    expect(msg.entity_id).toBe("ent-1");
    expect(msg.kind).toBe("WellProxy3D");

    const response = makeProxyResponse({ dims: [2, 2, 2], payloadBytes: 16 });
    source.handleProxyData(
      proxyResponseKey("ent-1", "WellProxy3D", 0, 0),
      response,
    );

    const result = await promise;
    expect(result.header.dims).toEqual([2, 2, 2]);
    expect(result.header.dtype).toBe("u16");
    expect(result.data.byteLength).toBe(16);
  });

  it("times out after the configured proxyTimeoutMs", async () => {
    const fastSource = new ProxiedContentSource(
      (json) => sentMessages.push(json),
      10_000,
      50,
    );
    const ctrl = new AbortController();
    const promise = fastSource.fetchProxy(
      { datasetId: "ds-1", entityId: "ent-1", kind: "WellProxy3D", t: 0, c: 0 },
      ctrl.signal,
    );
    vi.advanceTimersByTime(60);
    await expect(promise).rejects.toThrow(/timed out/);
  });

  it("aborts when the signal fires", async () => {
    const ctrl = new AbortController();
    const promise = source.fetchProxy(
      { datasetId: "ds-1", entityId: "ent-1", kind: "WellProxy3D", t: 0, c: 0 },
      ctrl.signal,
    );
    ctrl.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("propagates parse errors from a malformed header", async () => {
    const ctrl = new AbortController();
    const promise = source.fetchProxy(
      { datasetId: "ds-1", entityId: "ent-1", kind: "WellProxy3D", t: 0, c: 0 },
      ctrl.signal,
    );

    const bad = makeProxyResponse({ badMagic: true });
    source.handleProxyData(
      proxyResponseKey("ent-1", "WellProxy3D", 0, 0),
      bad,
    );

    await expect(promise).rejects.toThrow(/magic/i);
  });
});

// ---------------------------------------------------------------------------
// handleBinary dispatch
// ---------------------------------------------------------------------------

describe("ProxiedContentSource.handleBinary", () => {
  it("routes a `proxy/...` key to the proxy queue", async () => {
    const ctrl = new AbortController();
    const promise = source.fetchProxy(
      { datasetId: "ds-1", entityId: "ent-1", kind: "WellProxy3D", t: 0, c: 0 },
      ctrl.signal,
    );

    const response = makeProxyResponse({ dims: [2, 2, 2], payloadBytes: 16 });
    source.handleBinary(
      proxyResponseKey("ent-1", "WellProxy3D", 0, 0),
      response,
    );

    const result = await promise;
    expect(result.header.dims).toEqual([2, 2, 2]);
    expect(result.data.byteLength).toBe(16);
  });

  it("routes a non-proxy key to the chunk queue", async () => {
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
