/**
 * The published selection: one slot, one set at a time, with a listener for
 * the surface that highlights it. The dock writes it and the overlay reads
 * it, and neither imports the other.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { selectChunks } from "./diagnose/chunkSelection.ts";
import { lateStallOpen } from "./diagnose/fixtures.ts";
import {
  currentChunkSelection,
  onChunkSelectionChanged,
  publishChunkSelection,
} from "./linkedSelection.ts";

afterEach(() => {
  publishChunkSelection(null);
});

describe("the published selection", () => {
  it("starts empty, holds the set it is handed, and clears on null", () => {
    expect(currentChunkSelection()).toBeNull();

    const selection = selectChunks(lateStallOpen(), { startMs: 0, endMs: 1_000 });
    publishChunkSelection(selection);
    expect(currentChunkSelection()).toBe(selection);

    publishChunkSelection(null);
    expect(currentChunkSelection()).toBeNull();
  });

  it("tells a listener on every change and stops after it unsubscribes", () => {
    const heard = vi.fn();
    const stop = onChunkSelectionChanged(heard);

    const selection = selectChunks(lateStallOpen(), { startMs: 0, endMs: 1_000 });
    publishChunkSelection(selection);
    publishChunkSelection(null);
    expect(heard).toHaveBeenCalledTimes(2);

    stop();
    publishChunkSelection(selection);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("says nothing when the same set is published twice", () => {
    const heard = vi.fn();
    onChunkSelectionChanged(heard);
    const selection = selectChunks(lateStallOpen(), { startMs: 0, endMs: 1_000 });

    publishChunkSelection(selection);
    publishChunkSelection(selection);

    expect(heard).toHaveBeenCalledTimes(1);
  });
});
