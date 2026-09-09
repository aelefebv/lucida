import { describe, expect, it } from "vitest";

import {
  addSend,
  classifyClientMessage,
  SEND_COLUMN_COUNT,
  sendTalliesFrom,
  utf8ByteLength,
} from "./sendAccounting.ts";
import {
  CLIENT_MESSAGE_TYPES,
  CLIENT_MESSAGES,
  ClientMessageTypeIndex,
  SEND_COLUMNS,
} from "./types.ts";

describe("classifyClientMessage", () => {
  it("names every wire type the closed set carries, from the table that defines it", () => {
    CLIENT_MESSAGES.forEach((message, index) => {
      if (message.wire === null) return;
      const frame = JSON.stringify({ type: message.wire, rid: 3, dataset_id: "d" });
      expect(classifyClientMessage(frame), frame).toBe(index);
    });
  });

  it("counts every other message the page sends as other", () => {
    for (const type of [
      "request_snapshot",
      "open_remote_dataset",
      "dataset_health",
      "dataset_retry",
      "follow",
      "steer",
    ]) {
      expect(classifyClientMessage(JSON.stringify({ type })), type).toBe(ClientMessageTypeIndex.Other);
    }
  });

  it("does not let presence match a longer name, or a name match its prefix", () => {
    expect(classifyClientMessage('{"type":"presence_update"}')).toBe(ClientMessageTypeIndex.Other);
    expect(classifyClientMessage('{"type":"chunk"}')).toBe(ClientMessageTypeIndex.Other);
    expect(classifyClientMessage('{"type":"dataset_presence"}')).toBe(
      ClientMessageTypeIndex.DatasetPresence,
    );
  });

  it("counts a message whose first key is not type as other rather than parsing it", () => {
    expect(classifyClientMessage('{"rid":1,"type":"chunk_request"}')).toBe(ClientMessageTypeIndex.Other);
    expect(classifyClientMessage("")).toBe(ClientMessageTypeIndex.Other);
  });
});

describe("utf8ByteLength", () => {
  it("agrees with the encoder on ASCII, two-, three- and four-byte scalars", () => {
    const samples = [
      "",
      '{"type":"cursor","position":[412,233.5]}',
      "café",
      "€ 12",
      "label 😀 here",
      "߿ࠀ￿",
    ];
    for (const text of samples) {
      expect(utf8ByteLength(text), JSON.stringify(text)).toBe(new TextEncoder().encode(text).length);
    }
  });

  it("measures a stringified message as the socket will encode it", () => {
    const frame = JSON.stringify({ type: "command", command: { name: "résumé 🖼" } });
    expect(utf8ByteLength(frame)).toBe(new TextEncoder().encode(frame).length);
  });
});

describe("send-tally vectors", () => {
  it("lays out messages then bytes per type, in the closed set's order", () => {
    const columns = new Uint32Array(SEND_COLUMN_COUNT);
    addSend(columns, ClientMessageTypeIndex.Cursor, 43);
    addSend(columns, ClientMessageTypeIndex.Cursor, 77);

    expect(columns[ClientMessageTypeIndex.Cursor * SEND_COLUMNS]).toBe(2);
    expect(columns[ClientMessageTypeIndex.Cursor * SEND_COLUMNS + 1]).toBe(120);
    const tallies = sendTalliesFrom(columns);
    expect(Object.keys(tallies)).toEqual([...CLIENT_MESSAGE_TYPES]);
    expect(tallies.cursor).toEqual({ messages: 2, bytes: 120 });
    expect(tallies.chunkRequest).toEqual({ messages: 0, bytes: 0 });
  });

  it("reads a vector at an offset, as the tick ring stores them", () => {
    const columns = new Float64Array(SEND_COLUMN_COUNT * 2);
    addSend(columns.subarray(SEND_COLUMN_COUNT), ClientMessageTypeIndex.Presence, 301);

    expect(sendTalliesFrom(columns, 0).presence).toEqual({ messages: 0, bytes: 0 });
    expect(sendTalliesFrom(columns, SEND_COLUMN_COUNT).presence).toEqual({ messages: 1, bytes: 301 });
  });
});
