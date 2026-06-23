import { describe, it, expect } from "vitest";
import {
  resolveAnnotationDeepLink,
  type AnnotationDocScene,
} from "./annotationDeepLink.ts";
import type { Annotation } from "../components/AnnotationOverlay.tsx";

/** A structural scene stub exposing only what the resolver reads:
 *  annotation_dataset_ids() (the annotated datasets in doc order) and
 *  annotations(id) (the pins for a dataset). `byDataset` maps dataset id ->
 *  pins; unknown ids return "[]". */
function makeScene(byDataset: Record<string, Annotation[]>): AnnotationDocScene {
  return {
    annotation_dataset_ids: () => JSON.stringify(Object.keys(byDataset)),
    annotations: (datasetId: string) =>
      JSON.stringify(byDataset[datasetId] ?? []),
  };
}

function pin(id: string): Annotation {
  return {
    id,
    position: [10, 20],
    z: 3,
    author: "someone",
    kind: "point",
    comments: [],
  };
}

describe("resolveAnnotationDeepLink (slice 3)", () => {
  it("finds a pin and reports its OWNING dataset id (the clamp target)", () => {
    const scene = makeScene({
      "wds-1": [pin("p-a"), pin("p-b")],
      "wds-2": [pin("p-c")],
    });

    const result = resolveAnnotationDeepLink(scene, "p-c");

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.annotation.id).toBe("p-c");
      expect(result.datasetId).toBe("wds-2");
    }
  });

  it("searches ACROSS datasets — a pin on a non-first dataset still resolves", () => {
    const scene = makeScene({
      "wds-first": [pin("p-x")],
      "wds-second": [pin("p-target")],
    });

    const result = resolveAnnotationDeepLink(scene, "p-target");

    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.datasetId).toBe("wds-second");
  });

  it("returns not-found for an id that isn't in the loaded document (deleted/forged)", () => {
    const scene = makeScene({ "wds-1": [pin("p-a")] });

    const result = resolveAnnotationDeepLink(scene, "p-missing");

    expect(result.status).toBe("not-found");
  });

  it("returns not-found (never throws) for a null scene", () => {
    expect(resolveAnnotationDeepLink(null, "p-a").status).toBe("not-found");
  });

  it("returns not-found (never throws) when the document has NO annotations yet", () => {
    const scene = makeScene({});
    expect(resolveAnnotationDeepLink(scene, "p-a").status).toBe("not-found");
  });

  it("degrades to not-found on malformed annotation_dataset_ids JSON", () => {
    const scene: AnnotationDocScene = {
      annotation_dataset_ids: () => "not json{",
      annotations: () => "[]",
    };
    expect(resolveAnnotationDeepLink(scene, "p-a").status).toBe("not-found");
  });

  it("never throws on a null pin element and still finds a valid later pin (totality)", () => {
    // A malformed doc could carry a null/non-object entry in the pins array;
    // reading `.id` off it must not throw (the resolver documents "never
    // throws"). The bad element is skipped and a valid pin still resolves.
    const scene: AnnotationDocScene = {
      annotation_dataset_ids: () => JSON.stringify(["wds-1"]),
      annotations: () => JSON.stringify([null, pin("p-real")]),
    };

    const result = resolveAnnotationDeepLink(scene, "p-real");

    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.annotation.id).toBe("p-real");
  });

  it("returns not-found (never throws) when the ONLY pin element is null", () => {
    const scene: AnnotationDocScene = {
      annotation_dataset_ids: () => JSON.stringify(["wds-1"]),
      annotations: () => JSON.stringify([null]),
    };
    expect(resolveAnnotationDeepLink(scene, "p-a").status).toBe("not-found");
  });

  it("skips a dataset whose annotations JSON is malformed and keeps scanning", () => {
    const scene: AnnotationDocScene = {
      annotation_dataset_ids: () => JSON.stringify(["wds-bad", "wds-good"]),
      annotations: (id: string) =>
        id === "wds-bad" ? "broken{" : JSON.stringify([pin("p-found")]),
    };

    const result = resolveAnnotationDeepLink(scene, "p-found");

    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.datasetId).toBe("wds-good");
  });
});
