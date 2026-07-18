export type PlannedRankTier = "detail" | "coarse";

export function plannedRankKey(
  datasetId: string,
  imageId: string,
  tier: PlannedRankTier,
  chunkKey: string,
): string {
  return JSON.stringify([datasetId, imageId, tier, chunkKey]);
}
