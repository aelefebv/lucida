import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const IDLE_CRITICAL_SOURCES = [
  "components/AnnotationDraftOverlay.tsx",
  "components/VolumeViewer.tsx",
  "hooks/useFlyCameraInput.ts",
];

describe("idle animation callback budget", () => {
  it("keeps idle-critical features behind the shared demand-driven owner", () => {
    for (const relative of IDLE_CRITICAL_SOURCES) {
      const source = readFileSync(new URL(relative, import.meta.url), "utf8");
      expect(source, relative).not.toMatch(/requestAnimationFrame|cancelAnimationFrame/);
    }
  });
});
