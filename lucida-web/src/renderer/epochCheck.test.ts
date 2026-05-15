import { describe, it, expect } from "vitest";
import { isStaleDelivery } from "./epochCheck.ts";
import type { SceneEpochs } from "../pipeline/epochs.ts";

function makeEpochs(overrides?: Partial<SceneEpochs>): SceneEpochs {
  return { content: 1, layout: 1, view: 1, selection: 1, asset: 0, request: 0, ...overrides };
}

describe("isStaleDelivery", () => {
  it("same epochs → not stale", () => {
    const epochs = makeEpochs();
    expect(isStaleDelivery(epochs, epochs)).toBe(false);
  });

  it("older selectionEpoch → stale", () => {
    const delivery = makeEpochs({ selection: 0 });
    const current = makeEpochs({ selection: 1 });
    expect(isStaleDelivery(delivery, current)).toBe(true);
  });

  it("older contentEpoch → stale", () => {
    const delivery = makeEpochs({ content: 0 });
    const current = makeEpochs({ content: 1 });
    expect(isStaleDelivery(delivery, current)).toBe(true);
  });

  it("both older → stale", () => {
    const delivery = makeEpochs({ selection: 0, content: 0 });
    const current = makeEpochs({ selection: 1, content: 1 });
    expect(isStaleDelivery(delivery, current)).toBe(true);
  });

  it("older viewEpoch only → not stale", () => {
    const delivery = makeEpochs({ view: 0 });
    const current = makeEpochs({ view: 1 });
    expect(isStaleDelivery(delivery, current)).toBe(false);
  });

  it("older layoutEpoch only → not stale", () => {
    const delivery = makeEpochs({ layout: 0 });
    const current = makeEpochs({ layout: 1 });
    expect(isStaleDelivery(delivery, current)).toBe(false);
  });

  it("no current epochs (null) → not stale", () => {
    const delivery = makeEpochs();
    expect(isStaleDelivery(delivery, null)).toBe(false);
  });

  it("newer selectionEpoch → not stale", () => {
    const delivery = makeEpochs({ selection: 2 });
    const current = makeEpochs({ selection: 1 });
    expect(isStaleDelivery(delivery, current)).toBe(false);
  });

  it("older requestEpoch only → not stale", () => {
    const delivery = makeEpochs({ request: 0 });
    const current = makeEpochs({ request: 5 });
    expect(isStaleDelivery(delivery, current)).toBe(false);
  });
});
