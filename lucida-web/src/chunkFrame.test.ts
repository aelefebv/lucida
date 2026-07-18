import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { chunkFrameByteLength, decodeChunkFrame } from "./chunkFrame";

interface GoldenChunkFrame {
  client_id: number;
  dataset_id: string;
  image_id: string;
  chunk_key: string;
  payload_hex: string;
  frame_hex: string;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error("hex fixture must contain byte pairs");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

const fixturePath = fileURLToPath(
  new URL("../../wire-fixtures/binary/chunk_frame.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as GoldenChunkFrame;

describe("chunk-frame wire contract", () => {
  it("decodes the same committed bytes emitted by the Rust codec", () => {
    const encoded = fromHex(fixture.frame_hex);
    const result = decodeChunkFrame(encoded.buffer);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frame.clientId).toBe(fixture.client_id);
    expect(result.frame.key).toBe(
      `${fixture.dataset_id}/${fixture.image_id}/${fixture.chunk_key}`,
    );
    expect(new Uint8Array(result.frame.payload)).toEqual(fromHex(fixture.payload_hex));
  });

  it("prices the same committed bytes emitted by the Rust codec", () => {
    const encoded = fromHex(fixture.frame_hex);
    expect(chunkFrameByteLength(
      fixture.dataset_id,
      fixture.image_id,
      fixture.chunk_key,
      fromHex(fixture.payload_hex).byteLength,
    )).toBe(encoded.byteLength);
  });

  it("counts UTF-8 key bytes rather than JavaScript code units", () => {
    const key = "dätaset/imâge/0/0/0/0/0/0";
    expect(chunkFrameByteLength("dätaset", "imâge", "0/0/0/0/0/0", 17)).toBe(
      6 + new TextEncoder().encode(key).byteLength + 17,
    );
  });

  it("classifies every malformed prefix instead of partially decoding it", () => {
    expect(decodeChunkFrame(new Uint8Array(5).buffer)).toEqual({
      ok: false,
      reason: "truncated_header",
    });
    expect(decodeChunkFrame(Uint8Array.from([0, 0, 0, 0, 2, 0, 0x61]).buffer)).toEqual({
      ok: false,
      reason: "truncated_key",
    });
    expect(decodeChunkFrame(Uint8Array.from([0, 0, 0, 0, 1, 0, 0xff]).buffer)).toEqual({
      ok: false,
      reason: "invalid_utf8_key",
    });
  });
});
