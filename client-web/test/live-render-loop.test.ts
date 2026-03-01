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
