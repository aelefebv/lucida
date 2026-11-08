// A `SavedView` as the `#view=` payload of a URL. The codec is the core's
// (`lucida-core/src/saved_view/payload.rs`), shared with the CLI and the
// Python client, so a view makes the same payload whichever of them wrote it
// and the defaults a payload leaves out live in one place.

import { decode_view_payload, encode_view_payload } from "lucida-core";
import { SAVED_VIEW_VERSION, type SavedView } from "./types.ts";

export function encode(view: SavedView): string {
  return encode_view_payload(JSON.stringify(view));
}

/** Throws {@link SavedViewDecodeError} for a payload that is not a view. A
 *  view from a newer version applies best-effort, with a warning. */
export function decode(payload: string): SavedView {
  let view: SavedView;
  try {
    view = JSON.parse(decode_view_payload(payload)) as SavedView;
  } catch (e) {
    throw new SavedViewDecodeError(e instanceof Error ? e.message : String(e));
  }
  if (view.v > SAVED_VIEW_VERSION) {
    console.warn(
      `[SavedView] payload version ${view.v} exceeds known version ${SAVED_VIEW_VERSION}; applying best-effort.`,
    );
  }
  return view;
}

export class SavedViewDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SavedViewDecodeError";
  }
}
