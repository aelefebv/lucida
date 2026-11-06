/**
 * Overlay colors for tests: the dark canvas's tokens, resolved. Test support,
 * not product code.
 */

import { rgbColor } from "../theme/tokenColors.ts";
import { overlayPaints, type OverlayColors } from "./overlayDrawList.ts";

export const OVERLAY_TEST_COLORS: OverlayColors = {
  stroke: rgbColor(255, 255, 255, 0.85),
  label: rgbColor(255, 255, 255, 0.92),
  success: rgbColor(79, 207, 134),
  warning: rgbColor(245, 185, 74),
  danger: rgbColor(248, 113, 113),
  info: rgbColor(106, 170, 248),
};

export const OVERLAY_TEST_PAINTS = overlayPaints(OVERLAY_TEST_COLORS);
