/**
 * View hot-state builder.
 *
 * Walks the cold-state message's members (via `iterateColdMembers`,
 * the same canonical iteration the worker uses to build the descriptor
 * buffer) and emits one ray-hit-per-member entry. Composite member ids
 * (`imageId:chN`) are deduped — the camera ray hit is per-dataset, not
 * per-channel, so only the first composite per memberId carries it.
 *
 * Pure function — given a cold-state message + ray-hit + epochs +
 * datasetId, returns a `ViewHotStateMessage`. Extracted from
 * `Orchestrator.sendViewHotState` in Slice 6e of PRD #607 to make the
 * build mock-free.
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
