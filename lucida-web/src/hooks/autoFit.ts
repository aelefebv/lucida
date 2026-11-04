/**
 * Whether to auto-fit the camera on dataset open.
 *
 * `dataset_opened` is a broadcast that every co-present peer handles, but only
 * the client that opened the dataset should be reframed, so the server stamps
 * `opener_client_id`. A restore in progress owns the camera, and a follower must
 * stay on the leader's view. The three flags are independent gates, so one
 * regressing still leaves the others protecting the camera.
 */
export interface AutoFitContext {
  /** opener_client_id === self. */
  isOpener: boolean;
  /** A saved or last view is mid-restore and owns the camera. */
  restoreInProgress: boolean;
  following: boolean;
}

export function shouldAutoFitOnOpen(
  commandType: string,
  ctx: AutoFitContext,
): boolean {
  return (
    commandType === "dataset_opened" &&
    ctx.isOpener &&
    !ctx.restoreInProgress &&
    !ctx.following
  );
}

/**
 * Whether this client is the stamped opener of a `dataset_opened` broadcast.
 *
 * `!= null` rejects both an omitted field and serde `None`, so with no known
 * opener nobody fits. Id 0 is a real client id, not a sentinel.
 */
export function isOpenerOf(
  openerClientId: number | null | undefined,
  myId: number,
): boolean {
  return openerClientId != null && openerClientId === myId;
}
