/**
 * Decision for "auto-fit the camera on dataset open".
 *
 * Pure and side-effect-free so the policy can be unit-tested without a wasm
 * scene or a bridge. The bridge calls this in its `dataset_opened` handler and
 * only invokes the wasm fit when it returns `true`.
 *
 * `dataset_opened` is a BROADCAST: the bridge's command handler runs on every
 * co-present peer, not just the one that opened the dataset. We cannot tell the
 * opener apart from a bystander, though — the broadcast's `dataset_id` is a
 * server-minted random `wds-<uuid>` and the envelope carries no opener id, so
 * there is no client-derivable signal to correlate a broadcast back to a local
 * open. (An earlier origin gate keyed on `dataset_id_for_url` = `ds-<hash>`,
 * which can never equal the `wds-…` on the broadcast, so it suppressed every
 * open; it was removed.) What we CAN protect are the two unambiguously-wrong
 * cases, so all three of these must hold for an auto-fit:
 *  - the command is a fresh dataset open (`"dataset_opened"`), not some other
 *    broadcast routed through the same handler;
 *  - no saved/last view is mid-restore (`restoreInProgress`) — a restore owns
 *    the camera (#700);
 *  - this client is not following another's camera (`following`) — an auto-fit
 *    would yank a follower off the leader's view.
 *
 * The two context flags are independent gates (restore, follow), so a
 * regression in one alone still leaves the other protecting the camera.
 */
export interface AutoFitContext {
  /** A saved/last view is mid-restore and owns the camera. */
  restoreInProgress: boolean;
  /** This client is following another peer's camera. */
  following: boolean;
}

export function shouldAutoFitOnOpen(
  commandType: string,
  ctx: AutoFitContext,
): boolean {
  return (
    commandType === "dataset_opened" &&
    !ctx.restoreInProgress &&
    !ctx.following
  );
}
