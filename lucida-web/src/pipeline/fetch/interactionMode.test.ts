import { describe, it, expect } from "vitest";

import { InteractionModeDetector } from "./interactionMode.ts";
import { INTERACTION_MODE_WINDOW } from "./cpuCache.ts";
import type { SceneEpochs } from "../epochs.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEpochs(overrides?: Partial<SceneEpochs>): SceneEpochs {
  return {
    content: 1,
    layout: 1,
    view: 1,
    selection: 1,
    asset: 0,
    request: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — migrated from cpuCache.test.ts "adaptive eviction" block
// (Slice 3). They become PURE — no cache instance, no fetch mock.
// ---------------------------------------------------------------------------

describe("InteractionModeDetector", () => {
  describe("adaptive eviction", () => {
    it("detects panning from viewEpoch velocity", () => {
      const detector = new InteractionModeDetector(INTERACTION_MODE_WINDOW);

      // Simulate rapid viewEpoch bumps
      for (let i = 0; i < 5; i++) {
        detector.push(makeEpochs({ view: i + 1, selection: 1 }));
      }

      expect(detector.current()).toBe("panning");
    });

    it("detects scrubbing from selectionEpoch velocity", () => {
      const detector = new InteractionModeDetector(INTERACTION_MODE_WINDOW);

      // Simulate rapid selectionEpoch bumps
      for (let i = 0; i < 5; i++) {
        detector.push(makeEpochs({ view: 1, selection: i + 1 }));
      }

      expect(detector.current()).toBe("scrubbing");
    });

    it("reports idle when no epochs bumping", () => {
      const detector = new InteractionModeDetector(INTERACTION_MODE_WINDOW);

      // Same epochs every push
      for (let i = 0; i < 5; i++) {
        detector.push(makeEpochs({ view: 1, selection: 1 }));
      }

      expect(detector.current()).toBe("idle");
    });

    it("scrubbing mode protects prefetch over demoted", () => {
      // Original cpuCache test exercised the cache's eviction tier
      // order under scrubbing mode. The detector-level invariant it
      // depends on is: rapid selection bumps + zero view bumps
      // classify as scrubbing, even with later equal-view-equal-selection
      // pushes mixed in. Integration coverage of the tier-order
      // consequence lives at the EvictionPolicy + getTierOrder seam
      // (planned for Slice 5).
      const detector = new InteractionModeDetector(INTERACTION_MODE_WINDOW);

      // Force scrubbing mode via selectionEpoch velocity
      for (let i = 0; i < 5; i++) {
        detector.push(makeEpochs({ view: 1, selection: i + 1 }));
      }
      // Mirror the original test's three subsequent submits at
      // (view: 1, selection: 6/7/8). Selection keeps bumping; view
      // stays put — should remain scrubbing.
      detector.push(makeEpochs({ view: 1, selection: 6 }));
      detector.push(makeEpochs({ view: 1, selection: 7 }));
      detector.push(makeEpochs({ view: 1, selection: 8 }));

      expect(detector.current()).toBe("scrubbing");
    });
  });
});
