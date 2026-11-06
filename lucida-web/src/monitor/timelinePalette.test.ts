import { describe, expect, it } from "vitest";
import { TOKEN_NAMES } from "../theme/tokens.ts";
import {
  BAND_COLORS,
  CANVAS_COLORS,
  LANE_COLORS,
  MARK_COLORS,
  MESSAGE_COLORS,
  PHASE_COLORS,
  ROW_STATE_COLORS,
} from "./timelinePalette.ts";

const SERIES_TABLES = { PHASE_COLORS, ROW_STATE_COLORS, LANE_COLORS, MESSAGE_COLORS, MARK_COLORS };

describe("the timeline palette", () => {
  it("names only theme tokens, so both presets reach every chart", () => {
    const known = new Set<string>(TOKEN_NAMES);
    for (const table of [...Object.values(SERIES_TABLES), BAND_COLORS, CANVAS_COLORS]) {
      for (const color of Object.values(table)) {
        const name = /^var\((--lc-[\w-]+)\)$/.exec(color)?.[1];
        expect(name && known.has(name), color).toBe(true);
      }
    }
  });

  it.each(Object.entries(SERIES_TABLES))("gives each entry in %s a colour of its own", (_, table) => {
    const colors = Object.values(table);
    expect(new Set(colors).size).toBe(colors.length);
  });
});
