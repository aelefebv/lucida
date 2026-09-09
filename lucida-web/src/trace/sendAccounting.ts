/**
 * Send-side accounting: how a message the page transmits over the session
 * socket becomes a count in the trace.
 *
 * The bridge makes two measurements per transmitted message, its type and
 * its bytes, and hands them to the recorder, which tallies them per tick and
 * per interval against {@link CLIENT_MESSAGES}. Both measurements live here
 * rather than in the bridge so the tests that pin them need no socket, and
 * the column arithmetic the tick ring and the recorder share lives beside
 * them so a byte is counted the same way everywhere.
 *
 * Nothing here parses a message or copies one. Each send already pays a
 * `JSON.stringify` and the socket's own encode, and the accounting stays
 * small next to both: a prefix comparison for the type and one pass over
 * the code units for the bytes.
 */

import {
  CLIENT_MESSAGE_TYPES,
  CLIENT_MESSAGES,
  ClientMessageTypeIndex,
  SEND_COLUMNS,
  type ClientMessageTypeIndexValue,
  type SendTallies,
} from "./types.ts";

/** The width of one send-tally vector: messages and bytes per type. */
export const SEND_COLUMN_COUNT = CLIENT_MESSAGE_TYPES.length * SEND_COLUMNS;

/**
 * Every send site stringifies an object whose first key is `type`, so the
 * wire name sits at a fixed offset and a message is classified without being
 * parsed. A message that does not start this way counts as `other`.
 */
const TYPE_PREFIX = '{"type":"';
const TYPE_AT = TYPE_PREFIX.length;

/**
 * Each wire name with its closing quote, so `presence` cannot match a longer
 * name that starts with it.
 */
const WIRE_NAMES: readonly (readonly [string, ClientMessageTypeIndexValue])[] =
  CLIENT_MESSAGES.flatMap((message, index) =>
    message.wire === null ? [] : [[`${message.wire}"`, index] as const],
  );

/** Which of the closed set a message the page built counts under. */
export function classifyClientMessage(json: string): ClientMessageTypeIndexValue {
  if (json.startsWith(TYPE_PREFIX)) {
    for (let i = 0; i < WIRE_NAMES.length; i++) {
      if (json.startsWith(WIRE_NAMES[i][0], TYPE_AT)) return WIRE_NAMES[i][1];
    }
  }
  return ClientMessageTypeIndex.Other;
}

/**
 * The bytes a text message occupies on the wire, before framing.
 *
 * A WebSocket sends text as UTF-8, and a string's `length` counts UTF-16
 * code units, so the two agree only while a message is ASCII. Measured in
 * one pass over the code units rather than by encoding, which would allocate
 * a copy of every message on the send path. `JSON.stringify` escapes a lone
 * surrogate, so every surrogate seen here is half of a pair.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Count one message into a send-tally vector, laid out as {@link SEND_COLUMNS}
 * per type in {@link CLIENT_MESSAGE_TYPES} order: messages, then bytes.
 */
export function addSend(
  columns: Uint32Array | Float64Array,
  type: ClientMessageTypeIndexValue,
  bytes: number,
): void {
  const column = type * SEND_COLUMNS;
  columns[column] += 1;
  columns[column + 1] += bytes;
}

/** Read one send-tally vector, at `offset`, into the record the document carries. */
export function sendTalliesFrom(columns: ArrayLike<number>, offset = 0): SendTallies {
  const out = {} as SendTallies;
  for (let i = 0; i < CLIENT_MESSAGE_TYPES.length; i++) {
    const base = offset + i * SEND_COLUMNS;
    out[CLIENT_MESSAGE_TYPES[i]] = { messages: columns[base], bytes: columns[base + 1] };
  }
  return out;
}
