import type { PlanningEpochs } from "../pipeline/planning.ts";

/**
 * Returns true if the delivery is stale relative to the worker's current epoch state.
 * Only selectionEpoch and contentEpoch indicate data staleness.
 */
export function isStaleDelivery(
  deliveryEpochs: PlanningEpochs,
  currentEpochs: PlanningEpochs | null,
): boolean {
  if (!currentEpochs) return false;
  return (
    deliveryEpochs.selection < currentEpochs.selection ||
    deliveryEpochs.content < currentEpochs.content
  );
}
