import { describe, expect, it } from "vitest";
import type { WasmScene } from "lucida-core";
import { annotationCutCommand } from "./annotationCut.ts";
import type { Annotation } from "./annotationDocument.ts";

/** A scene whose active view, standing at `z` and at `cut` along its own
 * cut, answers `answer` for where a mark lies. */
function scene(answer: unknown, { z = 0, cut = 0 } = {}) {
  const asked: unknown[][] = [];
  const stub = {
    active_view: () => 2,
    z: () => z,
    cut_index: () => cut,
    annotation_cut: (...args: unknown[]) => {
      asked.push(args);
      return JSON.stringify(answer);
    },
  } as unknown as WasmScene;
  return { stub, asked };
}

const pin: Annotation = { id: "p", kind: "point", position: [12.5, 40.5], z: 7.25, author: "a" };

describe("annotationCutCommand", () => {
  it("asks for the plane holding the mark's anchor in the active view", () => {
    const { stub, asked } = scene({ axis: "z", position: 7 });
    expect(annotationCutCommand(stub, "ds", pin)).toEqual({ type: "set_z", z: 7 });
    expect(asked).toEqual([[2, "ds", 12.5, 40.5, 7.25]]);
  });

  it("steps a side view along the axis it cuts", () => {
    expect(annotationCutCommand(scene({ axis: "y", position: 40 }).stub, "ds", pin)).toEqual({ type: "set_y", y: 40 });
    expect(annotationCutCommand(scene({ axis: "x", position: 12 }).stub, "ds", pin)).toEqual({ type: "set_x", x: 12 });
  });

  it("does nothing where the view stands there already or knows no place", () => {
    expect(annotationCutCommand(scene({ axis: "z", position: 7 }, { z: 7 }).stub, "ds", pin)).toBeNull();
    expect(annotationCutCommand(scene({ axis: "y", position: 40 }, { cut: 40 }).stub, "ds", pin)).toBeNull();
    expect(annotationCutCommand(scene(null).stub, "ds", pin)).toBeNull();
  });
});
