import type { PlanningConfig } from "../pipeline/planning/config.ts";
import { renderRadiusEnabled } from "../pipeline/renderRadius.ts";
import type { ResidencyTier } from "../pipeline/residencyTier.ts";

export interface RadiusSpec {
  tier: ResidencyTier;
  radiusView: number;
}

export function radiusSpecsForOverlay(
  cfg: PlanningConfig,
  previewTier: ResidencyTier | null,
): RadiusSpec[] {
  const allRadiusSpecs: RadiusSpec[] = [
    { tier: "coarse", radiusView: cfg.coarseRenderRadiusView },
    { tier: "detail", radiusView: cfg.detailRenderRadiusView },
  ];
  return allRadiusSpecs
    .filter((spec) => previewTier === null || spec.tier === previewTier)
    .filter((spec) => renderRadiusEnabled(spec.radiusView));
}
