/**
 * **Send report**: the page's end of the workspace inbox. The bundle goes
 * over the session socket and `lucida trace inbox` reads it, which is the
 * only path an agent has to a session it did not start.
 *
 * Nothing here runs on its own: no schedule, no send on a run's close, no
 * retry. The only caller is the action, so the recording never leaves the
 * page unless somebody asks. The viewer registers the sender because the
 * session socket lives there.
 */

import type { InboxReceipt } from "../bridge.ts";

/**
 * How a registered sender posts one bundle: the serialised bundle in,
 * the inbox entry back. Rejects with the server's own sentence when
 * nothing was kept.
 */
export type ReportSender = (bundleJson: string) => Promise<InboxReceipt>;

/**
 * The largest bundle the inbox accepts.
 *
 * The server holds the same number (`lucida-server/src/inbox/mod.rs`),
 * and the two are a pair: neither is safe to change alone. It is checked
 * here so that meeting the limit is a sentence under the button with the
 * bundle still in the browser, rather than a refusal after megabytes
 * went over the socket.
 *
 * The comparison is on the string's length in UTF-16 code units, where
 * the server's is on bytes. They differ only where the bundle carries
 * text outside ASCII, and only in the direction of this check being the
 * looser one, so the server stays the authority and its refusal says the
 * same thing this one would have.
 */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

let registered: ReportSender | null = null;

/**
 * Register the viewer's sender, or withdraw it with null. Called by the
 * app while a session socket exists, so a page whose socket is gone
 * offers no send rather than a send that goes nowhere.
 */
export function setReportSender(sender: ReportSender | null): void {
  registered = sender;
}

export function reportSender(): ReportSender | null {
  return registered;
}

/**
 * Post one bundle to the workspace inbox.
 *
 * Serialised once, here, and the text is what travels, what the server
 * stores, and what the CLI fetches back — so the file an agent reads is
 * the file this page produced.
 */
export async function sendBundle(
  bundle: unknown,
  sender = reportSender(),
): Promise<InboxReceipt> {
  if (!sender) {
    throw new Error(
      "this page has no session to send a report over; save the bundle to a file instead",
    );
  }
  const bundleJson = JSON.stringify(bundle);
  if (bundleJson.length > MAX_BUNDLE_BYTES) {
    throw new Error(
      `this bundle is ${describeSize(bundleJson.length)}, over the inbox's ` +
        `${describeSize(MAX_BUNDLE_BYTES)} limit; save it to a file and attach it instead`,
    );
  }
  return sender(bundleJson);
}

function describeSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
