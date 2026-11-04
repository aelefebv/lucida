import { describe, it, expect } from "vitest";
import { datasetDisplayCommands } from "./applier.ts";
import type { DatasetDisplaySettings } from "./types.ts";

// The name-and-occurrence per-label restore in `datasetDisplayCommands`. A
// reordered, edited, or repeating label list must land each setting on the
// right current label. Without both name lists it falls back to positional.

const DS = "ds-1";

function baseSettings(overrides: Partial<DatasetDisplaySettings>): DatasetDisplaySettings {
  return {
    visible: true,
    opacity: 1,
    contrast_min: 0,
    contrast_max: 65535,
    gamma: 1,
    blend_mode: "alpha",
    ...overrides,
  };
}

/** The per-label commands as `[label, kind, value]` triples, in emission
 *  order. */
function labelCommands(
  cmds: ReturnType<typeof datasetDisplayCommands>,
): Array<[number, string, boolean | number]> {
  const out: Array<[number, string, boolean | number]> = [];
  for (const c of cmds) {
    if (c.type === "set_label_visible") out.push([c.label, "visible", c.visible]);
    else if (c.type === "set_label_opacity") out.push([c.label, "opacity", c.opacity]);
  }
  return out;
}

describe("datasetDisplayCommands per-label restore", () => {
  it("applies positionally with no captured label_names (legacy)", () => {
    const s = baseSettings({
      label_settings: [
        { visible: true, opacity: 0.1 },
        { visible: false, opacity: 0.2 },
      ],
    });
    // Even with current names known, absence of author names => positional.
    const cmds = labelCommands(datasetDisplayCommands(DS, s, ["b", "a"]));
    expect(cmds).toEqual([
      [0, "visible", true],
      [0, "opacity", 0.1],
      [1, "visible", false],
      [1, "opacity", 0.2],
    ]);
  });

  it("applies positionally when the caller supplies no current names (2-arg)", () => {
    const s = baseSettings({
      label_settings: [{ visible: true, opacity: 0.1 }],
      label_names: ["a"],
    });
    const cmds = labelCommands(datasetDisplayCommands(DS, s));
    expect(cmds).toEqual([
      [0, "visible", true],
      [0, "opacity", 0.1],
    ]);
  });

  it("keys per-label settings by name when the list is reordered", () => {
    const s = baseSettings({
      label_names: ["region-a", "region-b", "region-c"],
      label_settings: [
        { visible: true, opacity: 0.11 },
        { visible: true, opacity: 0.22 },
        { visible: true, opacity: 0.33 },
      ],
    });
    // Recipient order is a rotation: region-c, region-a, region-b.
    const cmds = labelCommands(
      datasetDisplayCommands(DS, s, ["region-c", "region-a", "region-b"]),
    );
    // Current index 0 (region-c) -> author 0.33, index 1 (region-a) -> 0.11, etc.
    expect(cmds.filter(([, k]) => k === "opacity")).toEqual([
      [0, "opacity", 0.33],
      [1, "opacity", 0.11],
      [2, "opacity", 0.22],
    ]);
  });

  it("emits nothing for a current label the author never had (added)", () => {
    const s = baseSettings({
      label_names: ["region-a", "region-b"],
      label_settings: [
        { visible: true, opacity: 0.11 },
        { visible: true, opacity: 0.22 },
      ],
    });
    const cmds = labelCommands(
      datasetDisplayCommands(DS, s, ["region-a", "region-c", "region-b"]),
    );
    // "region-c" (index 1) is new -> no command; the others map by name.
    expect(cmds.filter(([, k]) => k === "opacity")).toEqual([
      [0, "opacity", 0.11],
      [2, "opacity", 0.22],
    ]);
  });

  it("matches repeated names by occurrence", () => {
    const s = baseSettings({
      label_names: ["region-a", "region-b", "region-a"],
      label_settings: [
        { visible: true, opacity: 0.11 },
        { visible: true, opacity: 0.22 },
        { visible: true, opacity: 0.33 },
      ],
    });
    // Two current "region-a"s: the first takes the author's first "region-a" (0.11),
    // the second takes the author's second "region-a" (0.33); "region-b" -> 0.22.
    const cmds = labelCommands(
      datasetDisplayCommands(DS, s, ["region-a", "region-a", "region-b"]),
    );
    expect(cmds.filter(([, k]) => k === "opacity")).toEqual([
      [0, "opacity", 0.11],
      [1, "opacity", 0.33],
      [2, "opacity", 0.22],
    ]);
  });

  it("emits nothing for a repeated name with more current occurrences than the author had", () => {
    const s = baseSettings({
      label_names: ["region-a", "region-a"],
      label_settings: [
        { visible: true, opacity: 0.11 },
        { visible: true, opacity: 0.22 },
      ],
    });
    const cmds = labelCommands(
      datasetDisplayCommands(DS, s, ["region-a", "region-a", "region-a"]),
    );
    // Third "region-a" (index 2) has no matching author occurrence -> no command.
    expect(cmds.filter(([, k]) => k === "opacity")).toEqual([
      [0, "opacity", 0.11],
      [1, "opacity", 0.22],
    ]);
  });
});
