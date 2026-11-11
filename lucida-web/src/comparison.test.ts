import { describe, expect, it, vi } from "vitest";
import {
  comparisonActions,
  comparisonClip,
  intersectRects,
  lineUpReason,
  setAsideNote,
  type ComparisonScene,
} from "./comparison.ts";
import { resolvedLayer, resolvedLayers } from "./resolvedLayerFixtures.ts";
import { clipVolumeLayers } from "./volumePath.ts";
import type { VolumeLayerParams } from "./renderer/workerProtocol.ts";

/** A scene whose comparison shows each dataset over the given span. */
function spans(byId: Record<string, [number, number]>) {
  return { comparison_span: (_view: number, id: string) => new Float64Array(byId[id] ?? []) };
}

describe("where a compared dataset shows", () => {
  it("is a column of the target, and the two sides meet on one pixel boundary", () => {
    const scene = spans({ a: [0, 1 / 3], b: [1 / 3, 1] });
    const a = comparisonClip(scene, 0, "a", 1001, 600);
    const b = comparisonClip(scene, 0, "b", 1001, 600);
    expect(a).toEqual([0, 0, 334, 600]);
    expect(b).toEqual([334, 0, 667, 600]);
  });

  it("is everywhere for a dataset the comparison leaves alone, and nowhere for one a blink hides", () => {
    const scene = spans({ a: [0, 1], b: [0, 0] });
    expect(comparisonClip(scene, 0, "other", 800, 600)).toBeNull();
    expect(comparisonClip(scene, 0, "a", 800, 600)).toEqual([0, 0, 800, 600]);
    expect(comparisonClip(scene, 0, "b", 800, 600)).toBe("hidden");
  });

  it("narrows a volume layer's march to its side, and drops a layer left with no pixels", () => {
    const layer = (scissorRect?: [number, number, number, number]): VolumeLayerParams => ({
      datasetId: "a:0",
      blendMode: "additive",
      renderMode: "translucent",
      entityIndex: 0,
      scissorRect,
    });
    const layers = [layer([0, 0, 10, 10]), layer([100, 0, 300, 200]), layer([600, 0, 100, 100]), layer()];
    clipVolumeLayers(layers, 1, [0, 0, 400, 600]);
    expect(layers.map((l) => l.scissorRect)).toEqual([
      [0, 0, 10, 10],
      [100, 0, 300, 200],
      [0, 0, 400, 600],
    ]);
    expect(intersectRects([0, 0, 5, 5], [5, 0, 5, 5])).toBeNull();
  });
});

describe("what the compare bar says of the layers set aside", () => {
  it("counts the layers outside the pair that would otherwise draw", () => {
    const pair = [resolvedLayer("a"), resolvedLayer("b")];
    const aside = (id: string) => resolvedLayer(id, [0], { visible: false, set_aside: true });
    // A layer hidden by its own setting was hidden already.
    const hidden = resolvedLayer("hidden", [0], { visible: false });
    expect(setAsideNote(resolvedLayers(...pair, hidden))).toBeNull();
    expect(setAsideNote(resolvedLayers(...pair, aside("c"), hidden))).toBe("1 other layer hidden while comparing");
    expect(setAsideNote(resolvedLayers(...pair, aside("c"), aside("d")))).toBe("2 other layers hidden while comparing");
  });
});

describe("why a pair can't be compared", () => {
  const nameOf = (id: string) => id.toUpperCase();

  it("names the datasets that declare no scale", () => {
    expect(lineUpReason({ verdict: "yes" }, nameOf)).toBeNull();
    expect(lineUpReason({ verdict: "no_physical_scale", datasets: ["a"] }, nameOf)).toBe(
      "A has no physical scale to line up by.",
    );
    expect(lineUpReason({ verdict: "no_physical_scale", datasets: ["a", "b"] }, nameOf)).toBe(
      "A and B have no physical scale to line up by.",
    );
    expect(lineUpReason({ verdict: "apart" }, nameOf)).toBe("They don't overlap in physical space.");
  });
});

describe("the comparison controls", () => {
  function fakeScene(verdict = '{"verdict":"yes"}') {
    return {
      comparison: () => "null",
      comparison_span: () => [],
      datasets_line_up: () => verdict,
      compare: vi.fn(() => verdict),
      end_comparison: vi.fn(),
      set_comparison_mode: vi.fn(),
      set_comparison_divider: vi.fn(),
      flip_comparison: vi.fn(),
    } as unknown as ComparisonScene & Record<string, ReturnType<typeof vi.fn>>;
  }

  it("draw the next frame under the compare input, and nothing for a pair that was refused", () => {
    const scene = fakeScene();
    const loop = { markInteractiveDirty: vi.fn(), markResidencyDirty: vi.fn(), markInput: vi.fn() };
    const actions = comparisonActions(() => scene, () => loop);
    expect(actions.start("a", "b", "swipe")).toEqual({ verdict: "yes" });
    actions.setDivider(0.25);
    expect(scene.set_comparison_divider).toHaveBeenCalledWith(0.25);
    expect(loop.markInput.mock.calls).toEqual([["compare"], ["compare"]]);

    const refused = fakeScene('{"verdict":"apart"}');
    const quiet = { markInteractiveDirty: vi.fn(), markResidencyDirty: vi.fn(), markInput: vi.fn() };
    expect(comparisonActions(() => refused, () => quiet).start("a", "b", "blink")).toEqual({ verdict: "apart" });
    expect(quiet.markInput).not.toHaveBeenCalled();
  });
});
