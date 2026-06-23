import { describe, it, expect } from "vitest";
import {
  currentDatasetAnnotations,
  resolveAnnotationDatasetId,
  type AnnotationScene,
} from "./currentDatasetAnnotations.ts";

// A structural stand-in for the slice of WasmScene the resolver reads. Both
// methods return JSON strings, exactly like the real scene.
function makeScene(opts: {
  annotated?: string[];
  byDataset?: Record<string, unknown[]>;
  annotatedThrows?: boolean;
} = {}): AnnotationScene {
  return {
    annotation_dataset_ids: () => {
      if (opts.annotatedThrows) throw new Error("boom");
      return JSON.stringify(opts.annotated ?? []);
    },
    annotations: (id: string) => JSON.stringify(opts.byDataset?.[id] ?? []),
  };
}

describe("resolveAnnotationDatasetId", () => {
  it("returns the selected dataset id when one is selected (selection always wins)", () => {
    const scene = makeScene({ annotated: ["wds-other"] });
    expect(resolveAnnotationDatasetId(scene, "wds-selected")).toBe("wds-selected");
  });

  it("falls back to the FIRST annotated dataset when nothing is selected (the inbox window)", () => {
    // This is the linchpin of the #814-class fix: in the null-selection window
    // (0 datasets, or >=2 with none clicked) the Mentions inbox still resolves
    // the pin's REAL dataset, so restore clamps against its true extents instead
    // of "" (whose WASM volume shape is the [1,1,1] sentinel).
    const scene = makeScene({ annotated: ["wds-deep", "wds-2"] });
    expect(resolveAnnotationDatasetId(scene, null)).toBe("wds-deep");
  });

  it("returns null when nothing is selected and no dataset has annotations", () => {
    expect(resolveAnnotationDatasetId(makeScene({ annotated: [] }), null)).toBeNull();
  });

  it("returns null (never throws) when there is no scene", () => {
    expect(resolveAnnotationDatasetId(null, null)).toBeNull();
  });

  it("degrades to null when annotation_dataset_ids is unreadable", () => {
    expect(resolveAnnotationDatasetId(makeScene({ annotatedThrows: true }), null)).toBeNull();
  });
});

describe("currentDatasetAnnotations resolves through the same dataset id", () => {
  it("reads the selected dataset's pins when selected", () => {
    const scene = makeScene({
      annotated: ["wds-deep"],
      byDataset: { "wds-sel": [{ id: "p1" }], "wds-deep": [{ id: "p2" }] },
    });
    const out = currentDatasetAnnotations(scene, "wds-sel");
    expect(out.map((a) => (a as { id: string }).id)).toEqual(["p1"]);
  });

  it("reads the first-annotated dataset's pins in the null-selection window", () => {
    // The pin set and resolveAnnotationDatasetId agree on the SAME dataset, so a
    // caller that found a pin here can recover its owning dataset for the clamp.
    const scene = makeScene({
      annotated: ["wds-deep"],
      byDataset: { "wds-deep": [{ id: "p9" }] },
    });
    const out = currentDatasetAnnotations(scene, null);
    expect(out.map((a) => (a as { id: string }).id)).toEqual(["p9"]);
    expect(resolveAnnotationDatasetId(scene, null)).toBe("wds-deep");
  });
});
