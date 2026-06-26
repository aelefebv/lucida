/**
 * Decision for "auto-fit the camera on dataset open".
 *
 * Pure and side-effect-free so the policy can be unit-tested without a wasm
 * scene or a bridge. The bridge calls this in its `dataset_opened` handler and
 * only invokes the wasm fit when it returns `true`.
 *
 * `dataset_opened` is a BROADCAST: the bridge's command handler runs on every
 * co-present peer, not just the one that opened the dataset. The faithful intent
 * is "frame the newly-opened dataset for the user who opened it" — so the server
 * now stamps the broadcast with the originating client's id (`opener_client_id`)
 * and the bridge resolves `isOpener = opener_client_id === self`. (An earlier
 * attempt keyed on `dataset_id_for_url` = `ds-<hash>`, which can never equal the
 * server-minted `wds-…` on the broadcast, so it suppressed every open; it was
 * removed in favour of the server-stamped opener id.) All four of these must
 * hold for an auto-fit:
 *  - the command is a fresh dataset open (`"dataset_opened"`), not some other
 *    broadcast routed through the same handler;
 *  - this client is the one that opened the dataset (`isOpener`) — a co-present
 *    peer is NOT reframed when someone else opens a dataset;
 *  - no saved/last view is mid-restore (`restoreInProgress`) — a restore owns
 *    the camera (#700);
 *  - this client is not following another's camera (`following`) — an auto-fit
 *    would yank a follower off the leader's view.
 *
 * The three context flags are independent gates (opener, restore, follow), so a
 * regression in one alone still leaves the others protecting the camera. When
 * `opener_client_id` is absent (an older server, or self-id not yet known),
 * `isOpener` is false and no one fits — fail-safe, never a stray reframe.
 */
export interface AutoFitContext {
  /** This client is the one that opened the dataset (opener_client_id === self). */
  isOpener: boolean;
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
    ctx.isOpener &&
    !ctx.restoreInProgress &&
    !ctx.following
  );
}

/**
 * Whether THIS client (`myId`) is the one the server stamped as the opener of a
 * `dataset_opened` broadcast (`openerClientId`).
 *
 * Pure so the correlation can be unit-tested without a bridge. The `!= null`
 * check intentionally rejects BOTH `undefined` (an older server that omits the
 * field) and `null` (serde `None` → JSON `null`): in either case there is no
 * known opener, so no one claims the open and no one fits — fail-safe. Note id
 * `0` is a legitimate first-client id (the server allocates ids from 0), so it
 * must compare equal, not be treated as a sentinel.
 */
export function isOpenerOf(
  openerClientId: number | null | undefined,
  myId: number,
): boolean {
  return openerClientId != null && openerClientId === myId;
}
