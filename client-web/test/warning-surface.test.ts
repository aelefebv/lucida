import { describe, expect, it } from "vitest";

import {
  buildLayerBadges,
  buildSessionBadges,
  buildSessionNotice,
} from "../src/warning-surface";

describe("warning surfaces", () => {
  it("maps engine warnings into visible badges", () => {
    const badges = buildSessionBadges([
      {
        warningCode: "uncalibrated_overlay",
        severity: "warning",
        message: "Overlay calibration is missing.",
      },
      {
        warningCode: "generation_build_incomplete",
        severity: "info",
        message: "Generation is still refining.",
      },
    ]);

    expect(badges.map((badge) => badge.label)).toEqual([
      "Uncalibrated",
      "Generation incomplete",
    ]);
  });

  it("adds provenance badges for generation and computed-at-lod context", () => {
    const badges = buildLayerBadges(
      {
        layerId: "lay_0001",
        generationSeq: 7,
        sourceGenerationSeq: 7,
        computedAtLod: 3,
        pinned: true,
      },
      [],
    );
    const labels = badges.map((badge) => badge.label);

    expect(labels).toContain("gen 7");
    expect(labels).toContain("Pinned");
    expect(labels).toContain("LOD 3");
  });

  it("builds a concise session notice from highest-severity warning", () => {
    const notice = buildSessionNotice([
      {
        warningCode: "generation_build_incomplete",
        severity: "warning",
        message: "Generation 8 still refining.",
      },
      {
        warningCode: "missing_active_layer",
        severity: "error",
        message: "Active layer was removed.",
      },
    ]);

    expect(notice).toBe("Missing active layer: Active layer was removed.");
  });
});
