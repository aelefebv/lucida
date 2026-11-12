/**
 * Pure view hot-state builder: one ray hit per member of the view's draw. The
 * camera ray's hit is per dataset, not per channel, so every member gets the
 * same one.
 */
import type { ViewHotStateMessage } from "../../../renderer/workerProtocol.ts";
import type { SceneEpochs } from "../../epochs.ts";

/**
 * `memberIds` are the keys of the view's member index map: each member once,
 * in the canonical order the worker builds its descriptors in.
 */
export function buildViewHotState(args: {
  memberIds: Iterable<string>;
  rayHit: [number, number, number];
  epochs: SceneEpochs;
  datasetId: string;
  view: number;
}): ViewHotStateMessage {
  return {
    type: "viewHotState",
    epochs: args.epochs,
    datasetId: args.datasetId,
    view: args.view,
    rayHitsByEntity: Array.from(args.memberIds, (memberId): [string, [number, number, number]] => [memberId, args.rayHit]),
  };
}
