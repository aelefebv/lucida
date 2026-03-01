import { describe, expect, it } from "vitest";

import type { ClientState } from "../src/client-store";
import {
  LiveRenderLoop,
  type RenderFrameState,
} from "../src/live-render-loop";

describe("LiveRenderLoop", () => {
  it("retries preview fetch for the same generation after a transient failure", async () => {
    let previewCalls = 0;
    const frames: RenderFrameState[] = [];
    const loop = new LiveRenderLoop(
      "http://127.0.0.1:8787/v1/data",
      (frame) => {
        frames.push(frame);
      },
      async (input) => {
        const url = String(input);
        if (url.includes("/v1/preview2d/")) {
          previewCalls += 1;
          if (previewCalls === 1) {
            throw new Error("transient preview fetch failure");
          }
          return new Response(new Blob([toArrayBuffer(pgmPayload(2, 1, [25, 125]))]), {
            status: 200,
            headers: {
              "content-type": "image/x-portable-graymap",
              "content-encoding": "identity",
            },
          });
        }
        if (url.includes("/v1/tile2d/")) {
          const tile = channelBlockRawPayload(pgmPayload(2, 1, [200, 240]));
          return new Response(new Blob([toArrayBuffer(tile)]), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-encoding": "identity",
            },
          });
        }
        return new Response("", { status: 404 });
      },
    );

    loop.update(fixtureClientState());

    await waitFor(
      () => frames.some((frame) => frame.frameKind === "preview"),
      2000,
    );

    expect(previewCalls).toBeGreaterThanOrEqual(2);
    const latest = frames.at(-1);
    expect(latest?.width).toBe(2);
    expect(latest?.height).toBe(1);
    loop.dispose();
  });

  it("stretches low-range grayscale payloads for visibility", async () => {
    const frames: RenderFrameState[] = [];
    const loop = new LiveRenderLoop(
      "http://127.0.0.1:8787/v1/data",
      (frame) => {
        frames.push(frame);
      },
      async (input) => {
        const url = String(input);
        if (url.includes("/v1/preview2d/")) {
          return new Response(new Blob([toArrayBuffer(pgmPayload(2, 1, [2, 4]))]), {
            status: 200,
            headers: {
              "content-type": "image/x-portable-graymap",
              "content-encoding": "identity",
            },
          });
        }
        if (url.includes("/v1/tile2d/")) {
          return new Response(new Blob([toArrayBuffer(channelBlockRawPayload(pgmPayload(2, 1, [2, 4])))]), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-encoding": "identity",
            },
          });
        }
        return new Response("", { status: 404 });
      },
    );

    loop.update(fixtureClientState());
    await waitFor(() => frames.some((frame) => frame.frameKind === "tile"), 2000);

    const latest = frames.at(-1);
    expect(latest).toBeDefined();
    expect(latest?.rgba[0]).toBe(0);
    expect(latest?.rgba[1]).toBe(0);
    expect(latest?.rgba[2]).toBe(0);
    expect(latest?.rgba[4]).toBe(255);
    expect(latest?.rgba[5]).toBe(255);
    expect(latest?.rgba[6]).toBe(255);
    expect(latest?.pixelStats.min).toBe(2);
    expect(latest?.pixelStats.max).toBe(4);
    expect(latest?.pixelStats.nonZeroRatio).toBe(1);
    expect(latest?.pixelStats.mean).toBe(3);
    expect(latest?.sampleMax).toBe(255);
    expect(Array.from(latest?.grayscaleSamples ?? [])).toEqual([2, 4]);
    loop.dispose();
  });

  it("uses active t/z selection when requesting preview and tile payloads", async () => {
    const requestedUrls: string[] = [];
    const frames: RenderFrameState[] = [];
    const loop = new LiveRenderLoop(
      "http://127.0.0.1:8787/v1/data",
      (frame) => {
        frames.push(frame);
      },
      async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes("/v1/preview2d/")) {
          return new Response(new Blob([toArrayBuffer(pgmPayload(2, 1, [0, 255]))]), {
            status: 200,
            headers: {
              "content-type": "image/x-portable-graymap",
              "content-encoding": "identity",
            },
          });
        }
        if (url.includes("/v1/tile2d/")) {
          return new Response(new Blob([toArrayBuffer(channelBlockRawPayload(pgmPayload(2, 1, [0, 255])))]), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-encoding": "identity",
            },
          });
        }
        return new Response("", { status: 404 });
      },
    );

    const state = fixtureClientState();
    state.tIndex = 2;
    state.zIndex = 3;
    loop.update(state);

    await waitFor(() => frames.some((frame) => frame.frameKind === "tile"), 2000);

    expect(
      requestedUrls.some((url) => url.includes("/v1/preview2d/") && url.includes("/t/2/z/3/")),
    ).toBe(true);
    expect(
      requestedUrls.some((url) => url.includes("/v1/tile2d/") && url.includes("/t/2/z/3/")),
    ).toBe(true);
    loop.dispose();
  });

  it("reports empty-frame pixel stats when payload is all zeros", async () => {
    const frames: RenderFrameState[] = [];
    const loop = new LiveRenderLoop(
      "http://127.0.0.1:8787/v1/data",
      (frame) => {
        frames.push(frame);
      },
      async (input) => {
        const url = String(input);
        if (url.includes("/v1/preview2d/")) {
          return new Response(new Blob([toArrayBuffer(pgmPayload(2, 1, [0, 0]))]), {
            status: 200,
            headers: {
              "content-type": "image/x-portable-graymap",
              "content-encoding": "identity",
            },
          });
        }
        if (url.includes("/v1/tile2d/")) {
          return new Response(new Blob([toArrayBuffer(channelBlockRawPayload(pgmPayload(2, 1, [0, 0])))]), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-encoding": "identity",
            },
          });
        }
        return new Response("", { status: 404 });
      },
    );

    loop.update(fixtureClientState());
    await waitFor(() => frames.some((frame) => frame.frameKind === "tile"), 2000);

    const latest = frames.at(-1);
    expect(latest).toBeDefined();
    expect(latest?.pixelStats.min).toBe(0);
    expect(latest?.pixelStats.max).toBe(0);
    expect(latest?.pixelStats.nonZeroRatio).toBe(0);
    expect(latest?.pixelStats.mean).toBe(0);
    loop.dispose();
  });

  it("decodes 16-bit PGM payloads and reports 16-bit contrast range", async () => {
    const frames: RenderFrameState[] = [];
    const loop = new LiveRenderLoop(
      "http://127.0.0.1:8787/v1/data",
      (frame) => {
        frames.push(frame);
      },
      async (input) => {
        const url = String(input);
        if (url.includes("/v1/preview2d/")) {
          return new Response(
            new Blob([toArrayBuffer(pgm16Payload(2, 1, [87, 121]))]),
            {
              status: 200,
              headers: {
                "content-type": "image/x-portable-graymap",
                "content-encoding": "identity",
              },
            },
          );
        }
        if (url.includes("/v1/tile2d/")) {
          return new Response(
            new Blob([
              toArrayBuffer(
                channelBlockRawPayload(pgm16Payload(2, 1, [87, 121])),
              ),
            ]),
            {
              status: 200,
              headers: {
                "content-type": "application/octet-stream",
                "content-encoding": "identity",
              },
            },
          );
        }
        return new Response("", { status: 404 });
      },
    );

    const state = fixtureClientState();
    state.datasets.ds_fixture = {
      ...(state.datasets.ds_fixture ?? {
        datasetId: "ds_fixture",
        sourceId: "src_fixture",
        resolvedGenerationSeq: 1,
      }),
      dtype: "uint16",
    };
    loop.update(state);
    await waitFor(() => frames.some((frame) => frame.frameKind === "tile"), 2000);

    const latest = frames.at(-1);
    expect(latest).toBeDefined();
    expect(latest?.sampleMax).toBe(65535);
    expect(latest?.pixelStats.min).toBe(87);
    expect(latest?.pixelStats.max).toBe(121);
    expect(Array.from(latest?.grayscaleSamples ?? [])).toEqual([87, 121]);
    expect(latest?.rgba[0]).toBe(0);
    expect(latest?.rgba[4]).toBe(255);
    loop.dispose();
  });

  it("uses dtype bit depth for contrast max even when frame values fit in 8-bit range", async () => {
    const frames: RenderFrameState[] = [];
    const loop = new LiveRenderLoop(
      "http://127.0.0.1:8787/v1/data",
      (frame) => {
        frames.push(frame);
      },
      async (input) => {
        const url = String(input);
        if (url.includes("/v1/preview2d/")) {
          return new Response(new Blob([toArrayBuffer(pgmPayload(2, 1, [12, 120]))]), {
            status: 200,
            headers: {
              "content-type": "image/x-portable-graymap",
              "content-encoding": "identity",
            },
          });
        }
        if (url.includes("/v1/tile2d/")) {
          return new Response(new Blob([toArrayBuffer(channelBlockRawPayload(pgmPayload(2, 1, [12, 120])))]), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-encoding": "identity",
            },
          });
        }
        return new Response("", { status: 404 });
      },
    );

    const state = fixtureClientState();
    state.datasets.ds_fixture = {
      ...(state.datasets.ds_fixture ?? {
        datasetId: "ds_fixture",
        sourceId: "src_fixture",
        resolvedGenerationSeq: 1,
      }),
      dtype: "uint16",
    };
    loop.update(state);
    await waitFor(() => frames.some((frame) => frame.frameKind === "tile"), 2000);

    const latest = frames.at(-1);
    expect(latest).toBeDefined();
    expect(latest?.pixelStats.max).toBe(120);
    expect(latest?.sampleMax).toBe(65535);
    loop.dispose();
  });

  it("prefers the most recently upserted source when generation sequence ties", async () => {
    const requestedUrls: string[] = [];
    const frames: RenderFrameState[] = [];
    const loop = new LiveRenderLoop(
      "http://127.0.0.1:8787/v1/data",
      (frame) => {
        frames.push(frame);
      },
      async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        const isNewSource = url.includes("/src_new/");
        if (url.includes("/v1/preview2d/")) {
          if (isNewSource) {
            return new Response(
              new Blob([toArrayBuffer(pgm16Payload(2, 1, [87, 121]))]),
              {
                status: 200,
                headers: {
                  "content-type": "image/x-portable-graymap",
                  "content-encoding": "identity",
                },
              },
            );
          }
          return new Response(new Blob([toArrayBuffer(pgmPayload(2, 1, [0, 255]))]), {
            status: 200,
            headers: {
              "content-type": "image/x-portable-graymap",
              "content-encoding": "identity",
            },
          });
        }
        if (url.includes("/v1/tile2d/")) {
          if (isNewSource) {
            return new Response(
              new Blob([
                toArrayBuffer(
                  channelBlockRawPayload(pgm16Payload(2, 1, [87, 121])),
                ),
              ]),
              {
                status: 200,
                headers: {
                  "content-type": "application/octet-stream",
                  "content-encoding": "identity",
                },
              },
            );
          }
          return new Response(new Blob([toArrayBuffer(channelBlockRawPayload(pgmPayload(2, 1, [0, 255])))]), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-encoding": "identity",
            },
          });
        }
        return new Response("", { status: 404 });
      },
    );

    const state = fixtureClientState();
    state.sources = {
      src_old: {
        sourceId: "src_old",
        name: "old",
        status: "watching",
        latestWorkingGenerationSeq: 1,
      },
      src_new: {
        sourceId: "src_new",
        name: "new",
        status: "watching",
        latestWorkingGenerationSeq: 1,
      },
    };
    loop.update(state);

    await waitFor(() => frames.some((frame) => frame.frameKind === "tile"), 2000);

    expect(requestedUrls.some((url) => url.includes("/v1/preview2d/src_new/"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/v1/tile2d/src_new/"))).toBe(true);
    expect(frames.at(-1)?.sampleMax).toBe(65535);
    loop.dispose();
  });

  it("honors an explicit preferred source when selecting frames", async () => {
    const requestedUrls: string[] = [];
    const frames: RenderFrameState[] = [];
    const loop = new LiveRenderLoop(
      "http://127.0.0.1:8787/v1/data",
      (frame) => {
        frames.push(frame);
      },
      async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes("/v1/preview2d/")) {
          return new Response(new Blob([toArrayBuffer(pgmPayload(2, 1, [0, 255]))]), {
            status: 200,
            headers: {
              "content-type": "image/x-portable-graymap",
              "content-encoding": "identity",
            },
          });
        }
        if (url.includes("/v1/tile2d/")) {
          return new Response(new Blob([toArrayBuffer(channelBlockRawPayload(pgmPayload(2, 1, [0, 255])))]), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-encoding": "identity",
            },
          });
        }
        return new Response("", { status: 404 });
      },
    );

    const state = fixtureClientState();
    state.sources = {
      src_old: {
        sourceId: "src_old",
        name: "old",
        status: "watching",
        latestWorkingGenerationSeq: 3,
      },
      src_new: {
        sourceId: "src_new",
        name: "new",
        status: "watching",
        latestWorkingGenerationSeq: 1,
      },
    };
    loop.update(state, "src_new");

    await waitFor(() => frames.some((frame) => frame.frameKind === "tile"), 2000);

    expect(requestedUrls.some((url) => url.includes("/v1/preview2d/src_new/"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/v1/tile2d/src_new/"))).toBe(true);
    loop.dispose();
  });

  it("retries using the preferred source instead of falling back to another source", async () => {
    const requestedUrls: string[] = [];
    const frames: RenderFrameState[] = [];
    let srcNewPreviewAttempts = 0;
    const loop = new LiveRenderLoop(
      "http://127.0.0.1:8787/v1/data",
      (frame) => {
        frames.push(frame);
      },
      async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        const isNewSource = url.includes("/src_new/");
        if (url.includes("/v1/preview2d/")) {
          if (isNewSource) {
            srcNewPreviewAttempts += 1;
            if (srcNewPreviewAttempts === 1) {
              throw new Error("transient src_new preview failure");
            }
            return new Response(
              new Blob([toArrayBuffer(pgm16Payload(2, 1, [87, 121]))]),
              {
                status: 200,
                headers: {
                  "content-type": "image/x-portable-graymap",
                  "content-encoding": "identity",
                },
              },
            );
          }
          return new Response(new Blob([toArrayBuffer(pgmPayload(2, 1, [0, 255]))]), {
            status: 200,
            headers: {
              "content-type": "image/x-portable-graymap",
              "content-encoding": "identity",
            },
          });
        }
        if (url.includes("/v1/tile2d/")) {
          if (isNewSource) {
            return new Response(
              new Blob([
                toArrayBuffer(
                  channelBlockRawPayload(pgm16Payload(2, 1, [87, 121])),
                ),
              ]),
              {
                status: 200,
                headers: {
                  "content-type": "application/octet-stream",
                  "content-encoding": "identity",
                },
              },
            );
          }
          return new Response(new Blob([toArrayBuffer(channelBlockRawPayload(pgmPayload(2, 1, [0, 255])))]), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "content-encoding": "identity",
            },
          });
        }
        return new Response("", { status: 404 });
      },
    );

    const state = fixtureClientState();
    state.sources = {
      src_old: {
        sourceId: "src_old",
        name: "old",
        status: "watching",
        latestWorkingGenerationSeq: 3,
      },
      src_new: {
        sourceId: "src_new",
        name: "new",
        status: "watching",
        latestWorkingGenerationSeq: 1,
      },
    };
    loop.update(state, "src_new");

    await waitFor(
      () => frames.some((frame) => frame.frameKind === "tile"),
      2500,
    );

    expect(srcNewPreviewAttempts).toBeGreaterThanOrEqual(2);
    expect(requestedUrls.some((url) => url.includes("/src_old/"))).toBe(false);
    expect(frames.at(-1)?.sampleMax).toBe(65535);
    loop.dispose();
  });

  it("falls back to base t/z/channel-block tile when selected plane is unavailable", async () => {
    const requestedUrls: string[] = [];
    const frames: RenderFrameState[] = [];
    const loop = new LiveRenderLoop(
      "http://127.0.0.1:8787/v1/data",
      (frame) => {
        frames.push(frame);
      },
      async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes("/v1/preview2d/")) {
          return new Response(new Blob([toArrayBuffer(pgmPayload(2, 1, [11, 40]))]), {
            status: 200,
            headers: {
              "content-type": "image/x-portable-graymap",
              "content-encoding": "identity",
            },
          });
        }
        if (url.includes("/v1/tile2d/")) {
          if (url.includes("/t/1/") || url.includes("/z/1/") || url.includes("/cb/1/")) {
            return new Response("", { status: 404 });
          }
          return new Response(
            new Blob([toArrayBuffer(channelBlockRawPayload(pgmPayload(2, 1, [90, 180])))]),
            {
              status: 200,
              headers: {
                "content-type": "application/octet-stream",
                "content-encoding": "identity",
              },
            },
          );
        }
        return new Response("", { status: 404 });
      },
    );

    const state = fixtureClientState();
    state.tIndex = 1;
    state.zIndex = 1;
    state.selectedChannels = [4];
    loop.update(state);

    await waitFor(() => frames.some((frame) => frame.frameKind === "tile"), 2000);

    expect(
      requestedUrls.some((url) => url.includes("/v1/tile2d/src_fixture/gen/1/lod/0/t/1/z/1/cb/1/")),
    ).toBe(true);
    expect(
      requestedUrls.some((url) => url.includes("/v1/tile2d/src_fixture/gen/1/lod/0/t/0/z/0/cb/0/")),
    ).toBe(true);
    const latest = frames.at(-1);
    expect(latest?.frameKind).toBe("tile");
    expect(latest?.pixelStats.max).toBe(180);
    loop.dispose();
  });
});

function fixtureClientState(): ClientState {
  return {
    sessionId: "sess_fixture",
    sessionRev: 4,
    sceneRev: 3,
    clientId: "cli_fixture",
    viewRev: 1,
    activeLayerId: "lay_fixture",
    centerX: 0,
    centerY: 0,
    zoom: 1,
    zIndex: 0,
    tIndex: 0,
    selectedChannels: [0],
    sources: {
      src_fixture: {
        sourceId: "src_fixture",
        name: "fixture-source",
        status: "watching",
        latestWorkingGenerationSeq: 1,
      },
    },
    datasets: {
      ds_fixture: {
        datasetId: "ds_fixture",
        sourceId: "src_fixture",
        resolvedGenerationSeq: 1,
        dtype: "uint8",
      },
    },
    layers: {
      lay_fixture: {
        layerId: "lay_fixture",
        name: "raw",
        layerRev: 1,
        metadataRev: 0,
        writeRev: 0,
      },
    },
    generations: {},
    warnings: [],
    reconnectCount: 0,
  };
}

function pgmPayload(width: number, height: number, values: number[]): Uint8Array {
  const encoder = new TextEncoder();
  const header = encoder.encode(
    `P5\n${width.toString()} ${height.toString()}\n255\n`,
  );
  const pixels = new Uint8Array(values);
  const payload = new Uint8Array(header.length + pixels.length);
  payload.set(header, 0);
  payload.set(pixels, header.length);
  return payload;
}

function pgm16Payload(width: number, height: number, values: number[]): Uint8Array {
  const encoder = new TextEncoder();
  const header = encoder.encode(
    `P5\n${width.toString()} ${height.toString()}\n65535\n`,
  );
  const pixels = new Uint8Array(values.length * 2);
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] ?? 0;
    const clamped = Math.max(0, Math.min(65535, value));
    const offset = i * 2;
    pixels[offset] = (clamped >> 8) & 0xff;
    pixels[offset + 1] = clamped & 0xff;
  }
  const payload = new Uint8Array(header.length + pixels.length);
  payload.set(header, 0);
  payload.set(pixels, header.length);
  return payload;
}

function channelBlockRawPayload(payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(20);
  header[0] = 0x4c;
  header[1] = 0x43;
  header[2] = 0x42;
  header[3] = 0x4b;
  header[4] = 1;
  header[5] = 0;
  header[6] = 0;
  header[7] = 0;

  const view = new DataView(header.buffer);
  view.setUint16(8, 1, true);
  view.setUint16(10, 1, true);
  view.setUint32(12, payload.length, true);
  view.setUint32(16, payload.length, true);

  const block = new Uint8Array(header.length + payload.length);
  block.set(header, 0);
  block.set(payload, header.length);
  return block;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}


async function waitFor(
  check: () => boolean,
  timeoutMs: number,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  throw new Error("condition not met before timeout");
}
