/**
 * Pure view hot-state builder. Walks the cold-state message via
 * `iterateColdMembers` (same iteration the worker uses), emitting one
 * ray-hit per memberId. Composite ids (`imageId:chN`) dedup because the
 * camera ray hit is per-dataset, not per-channel.
 */
import type {
  ColdStateMessage,
  ViewHotStateMessage,
} from "../../../renderer/workerProtocol.ts";
import type { SceneEpochs } from "../../epochs.ts";
import { iterateColdMembers } from "../../../renderer/descriptorBuffer.ts";

export function buildViewHotState(args: {
  coldMsg: ColdStateMessage;
  rayHit: [number, number, number];
  epochs: SceneEpochs;
  datasetId: string;
}): ViewHotStateMessage {
  const rayHitsByEntity: Array<[string, [number, number, number]]> = [];
  const seen = new Set<string>();
  for (const { memberId } of iterateColdMembers(args.coldMsg)) {
    if (seen.has(memberId)) continue;
    seen.add(memberId);
    rayHitsByEntity.push([memberId, args.rayHit]);
  }
  return {
    type: "viewHotState",
    epochs: args.epochs,
    datasetId: args.datasetId,
    rayHitsByEntity,
  };
}
