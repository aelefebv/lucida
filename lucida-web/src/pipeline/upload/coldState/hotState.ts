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

/**
 * Core builder: one ray-hit per unique member id, in first-seen order.
 * Both the full path (member ids walked from a cold-state message) and the
 * view-move delta path (member ids walked from the planner active set) feed the
 * same dedup, so they emit identical hot state for the same members.
 */
export function buildViewHotStateFromMembers(args: {
  memberIds: Iterable<string>;
  rayHit: [number, number, number];
  epochs: SceneEpochs;
  datasetId: string;
}): ViewHotStateMessage {
  const rayHitsByEntity: Array<[string, [number, number, number]]> = [];
  const seen = new Set<string>();
  for (const memberId of args.memberIds) {
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

export function buildViewHotState(args: {
  coldMsg: ColdStateMessage;
  rayHit: [number, number, number];
  epochs: SceneEpochs;
  datasetId: string;
}): ViewHotStateMessage {
  const memberIds = (function* () {
    for (const { memberId } of iterateColdMembers(args.coldMsg)) yield memberId;
  })();
  return buildViewHotStateFromMembers({
    memberIds,
    rayHit: args.rayHit,
    epochs: args.epochs,
    datasetId: args.datasetId,
  });
}
