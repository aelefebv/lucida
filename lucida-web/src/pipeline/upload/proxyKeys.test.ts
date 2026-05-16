/**
 * Tests for the three `proxyKeyFromX` helpers.
 *
 * Pre-refactor (Slice 1 of PRD #607) these were characterization tests
 * exercising the orchestrator's public surface. Slice 2 lifted the
 * helpers to free functions, so the tests now call them directly.
 *
 * Contract:
 *   `${datasetId}|${entityId}|${kindOrProxyKind}|${t}|${c}`
 *
 * The point of having three helpers (one per input shape) instead of
 * one polymorphic helper is to keep call sites type-honest. Each test
 * pins one helper against the same canonical key to prove all three
 * shapes resolve to the identical composite string.
 */
import { describe, it, expect } from "vitest";
import {
  proxyKeyFromDelivery,
  proxyKeyFromMissing,
  proxyKeyFromRequest,
} from "./proxyKeys.ts";
import type { ReadyProxyDelivery } from "../fetch/index.ts";
import type { ProxyRequest } from "../planning/index.ts";
import type { MissingProxy } from "../../renderer/workerProtocol.ts";

const COMMON_KEY = "ds1|field-0|FieldProxy3D|3|2";

/** Equivalent input triples; each shape resolves to {@link COMMON_KEY}. */
const REQ: ProxyRequest = {
  datasetId: "ds1",
  entityId: "field-0",
  imageId: "img-0",
  kind: "FieldProxy3D",
  t: 3,
  c: 2,
  priority: 0,
};
const DELIVERY: ReadyProxyDelivery = {
  kind: "proxy",
  datasetId: "ds1",
  entityId: "field-0",
  imageId: "img-0",
  proxyKind: "FieldProxy3D",
  t: 3,
  c: 2,
  header: {
    algorithmVersion: 1,
    sourceContentHash: new Uint8Array(32),
    dims: [4, 4, 4],
    dtype: "u16",
  },
  data: new ArrayBuffer(128),
  epochs: { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 1 },
};
const MISSING: MissingProxy = {
  kind: "proxy",
  datasetId: "ds1",
  entityId: "field-0",
  proxyKind: "FieldProxy3D",
  t: 3,
  c: 2,
};

describe("proxyKeyFromDelivery / proxyKeyFromRequest / proxyKeyFromMissing", () => {
  it("proxyKeyFromDelivery produces the canonical composite key", () => {
    expect(proxyKeyFromDelivery(DELIVERY)).toBe(COMMON_KEY);
  });

  it("proxyKeyFromRequest produces the canonical composite key", () => {
    expect(proxyKeyFromRequest(REQ)).toBe(COMMON_KEY);
  });

  it("proxyKeyFromMissing produces the canonical composite key", () => {
    expect(proxyKeyFromMissing(MISSING)).toBe(COMMON_KEY);
  });
});
