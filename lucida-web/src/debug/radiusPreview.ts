import type { PlanningConfig } from "../pipeline/planning/config.ts";
import { renderRadiusEnabled } from "../pipeline/renderRadius.ts";
import type { RenderRadiusPreviewTier } from "./logging.ts";

export interface RadiusSpec {
  tier: RenderRadiusPreviewTier;
  radiusView: number;
}

export function radiusSpecsForOverlay(
  cfg: PlanningConfig,
  previewTier: RenderRadiusPreviewTier | null,
): RadiusSpec[] {
  const allRadiusSpecs: RadiusSpec[] = [
    { tier: "coarse", radiusView: cfg.coarseRenderRadiusView },
    { tier: "detail", radiusView: cfg.detailRenderRadiusView },
  ];
  return allRadiusSpecs
    .filter((spec) => previewTier === null || spec.tier === previewTier)
    .filter((spec) => renderRadiusEnabled(spec.radiusView));
}
