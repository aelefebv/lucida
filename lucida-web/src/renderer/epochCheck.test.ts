import { describe, it, expect } from "vitest";
import { isStaleDelivery } from "./epochCheck.ts";
import { makeSceneEpochs } from "../test/fixtures.ts";

describe("isStaleDelivery", () => {
  it("same epochs → not stale", () => {
    const epochs = makeSceneEpochs();
    expect(isStaleDelivery(epochs, epochs)).toBe(false);
  });

  it("older selectionEpoch → stale", () => {
    const delivery = makeSceneEpochs({ selection: 0 });
    const current = makeSceneEpochs({ selection: 1 });
    expect(isStaleDelivery(delivery, current)).toBe(true);
  });

  it("older contentEpoch → stale", () => {
    const delivery = makeSceneEpochs({ content: 0 });
    const current = makeSceneEpochs({ content: 1 });
    expect(isStaleDelivery(delivery, current)).toBe(true);
  });

  it("both older → stale", () => {
    const delivery = makeSceneEpochs({ selection: 0, content: 0 });
    const current = makeSceneEpochs({ selection: 1, content: 1 });
    expect(isStaleDelivery(delivery, current)).toBe(true);
  });

  it("older viewEpoch only → not stale", () => {
    const delivery = makeSceneEpochs({ view: 0 });
    const current = makeSceneEpochs({ view: 1 });
    expect(isStaleDelivery(delivery, current)).toBe(false);
  });

  it("older layoutEpoch only → not stale", () => {
    const delivery = makeSceneEpochs({ layout: 0 });
    const current = makeSceneEpochs({ layout: 1 });
    expect(isStaleDelivery(delivery, current)).toBe(false);
  });

  it("no current epochs (null) → not stale", () => {
    const delivery = makeSceneEpochs();
    expect(isStaleDelivery(delivery, null)).toBe(false);
  });

  it("newer selectionEpoch → not stale", () => {
    const delivery = makeSceneEpochs({ selection: 2 });
    const current = makeSceneEpochs({ selection: 1 });
    expect(isStaleDelivery(delivery, current)).toBe(false);
  });

  it("older requestEpoch only → not stale", () => {
    const delivery = makeSceneEpochs({ request: 0 });
    const current = makeSceneEpochs({ request: 5 });
    expect(isStaleDelivery(delivery, current)).toBe(false);
  });
});
