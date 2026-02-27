const test = require("node:test");
const assert = require("node:assert/strict");

const helpers = require("../../crates/lucida-daemon/ui/viewer_helpers.js");

test("clampZoom clamps invalid and out-of-range values", () => {
  assert.equal(helpers.clampZoom(Number.NaN), 1.0);
  assert.equal(helpers.clampZoom(-5), 0.02);
  assert.equal(helpers.clampZoom(10000), 4096);
  assert.equal(helpers.clampZoom(2.5), 2.5);
});

test("screenDeltaToWorld maps screen deltas at zero rotation", () => {
  const [u, v] = helpers.screenDeltaToWorld(40, -20, 2, 1, 0);
  assert.equal(u, 20);
  assert.equal(v, -10);
});

test("selectorIndex resolves index/range/set selectors", () => {
  const selectors = [
    { axis: "z", kind: "index", index: 7 },
    { axis: "t", kind: "range", start: 2, end_exclusive: 3 },
    { axis: "c", kind: "set", indices: [4, 1] },
  ];
  assert.equal(helpers.selectorIndex(selectors, "z"), 7);
  assert.equal(helpers.selectorIndex(selectors, "t"), 2);
  assert.equal(helpers.selectorIndex(selectors, "c"), 4);
  assert.equal(helpers.selectorIndex(selectors, "x"), null);
});

test("selectorsWithReplacement replaces only target axis", () => {
  const selectors = [
    { axis: "z", kind: "index", index: 1 },
    { axis: "t", kind: "index", index: 2 },
  ];
  const replaced = helpers.selectorsWithReplacement(selectors, "z", 9);
  assert.equal(replaced.length, 2);
  assert.equal(replaced.find((selector) => selector.axis === "z").index, 9);
  assert.equal(replaced.find((selector) => selector.axis === "t").index, 2);
});

test("computePlanePatch preserves role-mapped center and slice", () => {
  const viewState = {
    selectors: [{ axis: "z", kind: "index", index: 3, clamp: true }],
    view_2d: {
      plane: "xy",
      camera: {
        center_world: [10, 20],
      },
      slice: {
        axis: "z",
        index: 3,
      },
    },
  };

  const patch = helpers.computePlanePatch(viewState, "xz");
  const centerPatch = patch.find((entry) => entry.path === "/view_2d/camera/center_world");
  const slicePatch = patch.find((entry) => entry.path === "/view_2d/slice");
  assert.deepEqual(centerPatch.value, [10, 3]);
  assert.equal(slicePatch.value.index, 20);
});
