import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Bridge, type BridgeHandlers } from "./bridge.ts";
import {
  FakeWebSocket,
  installFakeWebSocket,
  makeBridgeHandlers,
} from "./test/fakeWebSocket.ts";

/**
 * Seq discipline of the sequenced document stream, driven through the real
 * `Bridge` dispatch:
 *
 * - in-order broadcasts/acks apply and advance tracking;
 * - a seq hole is buffered behind a short grace timer — a late
 *   out-of-order arrival fills it silently (the server sends broadcasts
 *   after releasing the session lock, so concurrent editors reorder
 *   without loss), and only a persistent hole produces exactly one
 *   `request_snapshot`;
 * - the answering snapshot re-baselines tracking, drops already-covered
 *   entries (no double-apply), and applies the newer tail in order;
 * - stale `dataset_opened` rebroadcasts (open-dedup) pass through ONLY
 *   for datasets the document still contains — a retained rebroadcast
 *   must not resurrect a dataset the snapshot deleted;
 * - the author's locally-applied-but-unacked commands are replayed after
 *   a snapshot full-replace and retired by their acks — including the
 *   accepted tradeoff when a snapshot outruns an ack and the replay
 *   stomps a newer peer value (local-only, bounded by the next
 *   edit/snapshot).
 */
function openBridge(overrides: Partial<BridgeHandlers> = {}) {
  const handlers = makeBridgeHandlers(overrides);
  const bridge = new Bridge(handlers, "ws://test/ws/workspaces/w1");
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.open();
  return { bridge, ws, handlers };
}

function deliver(ws: FakeWebSocket, raw: string): void {
  ws.receive(raw);
}

function snapshotMsg(seq: number, manifests: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "snapshot",
    seq,
    document: { manifests },
    peers: [],
    your_id: 7,
  });
}

function broadcastMsg(
  seq: number,
  command: Record<string, unknown> = { type: "set_active_layout", dataset_id: `ds-${seq}`, layout_id: "L" },
): string {
  return JSON.stringify({ type: "command_broadcast", seq, command });
}

function datasetOpenedCmd(datasetId: string): Record<string, unknown> {
  return { type: "dataset_opened", manifest: { dataset_id: datasetId } };
}

function datasetOpenSucceededMsg(seq: number, datasetId: string): string {
  return JSON.stringify({
    type: "open_dataset_succeeded",
    request_id: `open-${seq}`,
    url: `/data/${datasetId}.zarr`,
    seq,
    summary: {
      workspace_dataset_id: datasetId,
      name: `${datasetId}.zarr`,
      image_count: 1,
      entity_count: 1,
    },
    opened: {
      manifest: { dataset_id: datasetId },
      fetch: { Proxied: { images: [] } },
      opener_client_id: 7,
    },
  });
}

function ackMsg(seq: number, requestId = `untracked-${seq}`): string {
  return JSON.stringify({ type: "ack", request_id: requestId, seq });
}

function nackMsg(
  requestId: string,
  code = "forbidden",
  message = "command rejected",
  retryable = false,
): string {
  return JSON.stringify({
    type: "nack",
    request_id: requestId,
    code,
    message,
    retryable,
  });
}

/** Count `request_snapshot` envelopes transmitted on this socket. */
function resyncRequests(ws: FakeWebSocket): number {
  return ws.sent.filter((raw) => JSON.parse(raw).type === "request_snapshot").length;
}

/** The seqs `onCommand` was invoked with, in call order. */
function appliedSeqs(handlers: BridgeHandlers): number[] {
  return (handlers.onCommand as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as number);
}

/** The command JSON bodies `onCommand` was invoked with, in call order. */
function appliedCommands(handlers: BridgeHandlers): string[] {
  return (handlers.onCommand as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string);
}

/** Comfortably past RESYNC_GRACE_MS (200) without reaching the reconnect
 *  timer (2000) or the retry interval (5000). */
const PAST_GRACE_MS = 250;

describe("Bridge sequenced-stream gap detection and snapshot resync", () => {
  beforeEach(() => {
    installFakeWebSocket();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("applies a contiguous stream without ever requesting a snapshot", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10));
    deliver(ws, broadcastMsg(11));
    deliver(ws, broadcastMsg(12));
    deliver(ws, broadcastMsg(13));
    vi.advanceTimersByTime(1000);

    expect(appliedSeqs(handlers)).toEqual([11, 12, 13]);
    expect(resyncRequests(ws)).toBe(0);
  });

  it("normalizes requester dataset-open success into the sequenced command stream", () => {
    const onOpenDatasetSucceeded = vi.fn();
    const { ws, handlers } = openBridge({ onOpenDatasetSucceeded });
    deliver(ws, snapshotMsg(42));
    deliver(ws, datasetOpenSucceededMsg(43, "wds-opened"));
    deliver(ws, broadcastMsg(44));

    expect(appliedSeqs(handlers)).toEqual([43, 44]);
    expect(JSON.parse(appliedCommands(handlers)[0])).toStrictEqual({
      type: "dataset_opened",
      manifest: { dataset_id: "wds-opened" },
      fetch: { Proxied: { images: [] } },
      opener_client_id: 7,
    });
    expect(onOpenDatasetSucceeded).toHaveBeenCalledExactlyOnceWith(
      "open-43",
      "/data/wds-opened.zarr",
      43,
      {
        workspace_dataset_id: "wds-opened",
        name: "wds-opened.zarr",
        image_count: 1,
        entity_count: 1,
      },
    );
    expect(resyncRequests(ws)).toBe(0);
  });

  it("a persistent seq hole buffers the broadcast and, after the grace window, sends exactly one request_snapshot", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10));
    deliver(ws, broadcastMsg(11));
    deliver(ws, broadcastMsg(14)); // 12–13 missing

    // Within the grace window nothing is requested yet: the hole may be
    // benign reordering about to fill itself.
    expect(resyncRequests(ws)).toBe(0);
    expect(appliedSeqs(handlers)).toEqual([11]); // 14 held back, not applied out of order

    vi.advanceTimersByTime(PAST_GRACE_MS);
    expect(resyncRequests(ws)).toBe(1);
    expect(JSON.parse(ws.sent[ws.sent.length - 1])).toStrictEqual({ type: "request_snapshot" });
  });

  it("a hole filled by a late out-of-order arrival never requests a snapshot", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10));
    deliver(ws, broadcastMsg(13)); // hole: 11–12 still in flight
    deliver(ws, broadcastMsg(11)); // late arrivals (server sends after unlock)
    deliver(ws, broadcastMsg(12));
    vi.advanceTimersByTime(1000); // grace fires into an empty buffer — no-op

    expect(appliedSeqs(handlers)).toEqual([11, 12, 13]);
    expect(resyncRequests(ws)).toBe(0);
  });

  it("a gap storm produces one request, not one per gapped message", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10));
    for (let seq = 14; seq < 30; seq++) {
      deliver(ws, broadcastMsg(seq));
    }
    vi.advanceTimersByTime(PAST_GRACE_MS);
    for (let seq = 30; seq < 40; seq++) {
      deliver(ws, broadcastMsg(seq)); // still gapped, request already in flight
    }
    vi.advanceTimersByTime(PAST_GRACE_MS);

    expect(appliedSeqs(handlers)).toEqual([]);
    expect(resyncRequests(ws)).toBe(1);
  });

  it("the answering snapshot drops covered entries, applies the newer tail, and tracking resumes", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10));
    deliver(ws, broadcastMsg(11));
    deliver(ws, broadcastMsg(14)); // hole → buffered
    vi.advanceTimersByTime(PAST_GRACE_MS); // persists → request
    deliver(ws, broadcastMsg(15)); // buffered behind the in-flight request
    expect(resyncRequests(ws)).toBe(1);

    // The snapshot was taken at seq 14, so 14 is already reflected in it
    // (must NOT re-apply) while 15 is newer and must apply.
    deliver(ws, snapshotMsg(14));
    expect(handlers.onSnapshot).toHaveBeenCalledTimes(2);
    expect(appliedSeqs(handlers)).toEqual([11, 15]);

    // Normal tracking resumed from the buffered tail.
    deliver(ws, broadcastMsg(16));
    expect(appliedSeqs(handlers)).toEqual([11, 15, 16]);
    expect(resyncRequests(ws)).toBe(1);
  });

  it("a stale broadcast arriving after the snapshot is ignored (no double-apply)", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(20));
    deliver(ws, broadcastMsg(18)); // retained pre-snapshot message replayed late
    vi.advanceTimersByTime(1000);

    expect(appliedSeqs(handlers)).toEqual([]);
    expect(resyncRequests(ws)).toBe(0);

    deliver(ws, broadcastMsg(21));
    expect(appliedSeqs(handlers)).toEqual([21]);
  });

  it("delivers a dataset_opened rebroadcast at a duplicate seq for a still-present dataset (open-dedup)", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(5, { "wds-1": {} }));
    // The server rebroadcasts an already-applied DatasetOpened at the
    // CURRENT seq when an open dedups onto an existing binding; its apply
    // is an idempotent full-replace and carries the re-stamped opener.
    deliver(ws, broadcastMsg(5, datasetOpenedCmd("wds-1")));

    expect(appliedSeqs(handlers)).toEqual([5]);
    expect(resyncRequests(ws)).toBe(0);

    deliver(ws, broadcastMsg(6));
    expect(appliedSeqs(handlers)).toEqual([5, 6]);
  });

  it("a stale dataset_opened for a dataset the snapshot deleted is dropped, not resurrected", () => {
    const { ws, handlers } = openBridge();
    // Repair snapshot at seq 21: wds-D was removed at seq 21 and is gone
    // from the document. The retained dedup rebroadcast of wds-D (stamped
    // at the then-current seq 20) arrives afterwards; delivering it would
    // re-add a deleted dataset with dead bindings.
    deliver(ws, snapshotMsg(21, { "wds-keep": {} }));
    deliver(ws, broadcastMsg(20, datasetOpenedCmd("wds-D")));

    expect(appliedSeqs(handlers)).toEqual([]);

    // A still-present dataset's rebroadcast keeps working alongside.
    deliver(ws, broadcastMsg(21, datasetOpenedCmd("wds-keep")));
    expect(appliedCommands(handlers)).toEqual([JSON.stringify(datasetOpenedCmd("wds-keep"))]);
    expect(resyncRequests(ws)).toBe(0);
  });

  it("a gap-buffered dataset_opened below the snapshot's seq honors the membership gate on drain", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10, { "wds-A": {} }));
    // Gapped: buffered until the snapshot answers.
    deliver(ws, broadcastMsg(12, datasetOpenedCmd("wds-D")));
    vi.advanceTimersByTime(PAST_GRACE_MS);
    expect(resyncRequests(ws)).toBe(1);

    // The snapshot (seq 13) no longer contains wds-D — the buffered entry
    // is covered AND deleted; it must not be delivered on drain.
    deliver(ws, snapshotMsg(13, { "wds-A": {} }));
    expect(appliedSeqs(handlers)).toEqual([]);

    // Same shape, but the dataset survives in the snapshot: delivered.
    deliver(ws, broadcastMsg(15, datasetOpenedCmd("wds-A")));
    vi.advanceTimersByTime(PAST_GRACE_MS);
    deliver(ws, snapshotMsg(16, { "wds-A": {} }));
    expect(appliedCommands(handlers)).toEqual([JSON.stringify(datasetOpenedCmd("wds-A"))]);
  });

  it("membership for the stale-dataset_opened gate tracks live commands, not just the snapshot", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(5));
    // wds-N opened AFTER the snapshot: the mirror must learn it so its
    // dedup rebroadcast still passes.
    deliver(ws, broadcastMsg(6, datasetOpenedCmd("wds-N")));
    deliver(ws, broadcastMsg(6, datasetOpenedCmd("wds-N"))); // dedup rebroadcast at current seq
    expect(appliedSeqs(handlers)).toEqual([6, 6]);

    // ...and removed after: the mirror must forget it again.
    deliver(ws, broadcastMsg(7, { type: "remove_dataset", id: "wds-N" }));
    deliver(ws, broadcastMsg(7, datasetOpenedCmd("wds-N"))); // retained rebroadcast — dead dataset
    expect(appliedSeqs(handlers)).toEqual([6, 6, 7]);
  });

  it("an ack of our own command advances tracking like a broadcast", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(3));
    deliver(ws, ackMsg(4)); // our command, applied optimistically before sending
    deliver(ws, broadcastMsg(5));
    vi.advanceTimersByTime(1000);

    expect(handlers.onAck).toHaveBeenCalledWith(4, "untracked-4");
    expect(appliedSeqs(handlers)).toEqual([5]);
    expect(resyncRequests(ws)).toBe(0);
  });

  it("an ack past a persistent gap triggers a resync, and the snapshot restores tracking", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(3));
    deliver(ws, ackMsg(6)); // 4–5 (peers' broadcasts) missing
    vi.advanceTimersByTime(PAST_GRACE_MS);

    expect(resyncRequests(ws)).toBe(1);

    deliver(ws, snapshotMsg(6));
    deliver(ws, broadcastMsg(7));
    expect(appliedSeqs(handlers)).toEqual([7]);
    expect(resyncRequests(ws)).toBe(1);
  });

  it("a residual gap after the snapshot requests another resync", () => {
    const { ws } = openBridge();
    deliver(ws, snapshotMsg(10));
    deliver(ws, broadcastMsg(15)); // hole
    vi.advanceTimersByTime(PAST_GRACE_MS); // persists → request #1
    expect(resyncRequests(ws)).toBe(1);

    // Snapshot answers, but was taken at seq 12 — 13–14 are still missing
    // below the buffered 15, so the drain must ask again.
    deliver(ws, snapshotMsg(12));
    vi.advanceTimersByTime(PAST_GRACE_MS);
    expect(resyncRequests(ws)).toBe(2);
  });

  it("re-requests after the retry interval if the first request went unanswered", () => {
    const { ws } = openBridge();
    deliver(ws, snapshotMsg(10));
    deliver(ws, broadcastMsg(14));
    vi.advanceTimersByTime(PAST_GRACE_MS);
    expect(resyncRequests(ws)).toBe(1);

    deliver(ws, broadcastMsg(15));
    vi.advanceTimersByTime(PAST_GRACE_MS);
    expect(resyncRequests(ws)).toBe(1); // still in flight — no spam

    vi.advanceTimersByTime(5001);
    deliver(ws, broadcastMsg(16));
    vi.advanceTimersByTime(PAST_GRACE_MS);
    expect(resyncRequests(ws)).toBe(2);
  });

  it("a standing hole re-requests on the retry timer with zero further inbound traffic", () => {
    const { ws } = openBridge();
    deliver(ws, snapshotMsg(10));
    deliver(ws, broadcastMsg(14)); // hole
    vi.advanceTimersByTime(PAST_GRACE_MS);
    expect(resyncRequests(ws)).toBe(1);

    // No further traffic at all: the retry timer alone must drive recovery
    // (a request eaten by the server's per-client throttle, or lost on the
    // wire, would otherwise strand an idle workspace's buffered tail
    // forever).
    vi.advanceTimersByTime(5000);
    expect(resyncRequests(ws)).toBe(2);
    vi.advanceTimersByTime(5000);
    expect(resyncRequests(ws)).toBe(3);
  });

  it("the retry timer stops once the hole resolves", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10));
    deliver(ws, broadcastMsg(13)); // hole
    vi.advanceTimersByTime(PAST_GRACE_MS);
    expect(resyncRequests(ws)).toBe(1);

    deliver(ws, broadcastMsg(11)); // late arrivals fill the hole
    deliver(ws, broadcastMsg(12));
    expect(appliedSeqs(handlers)).toEqual([11, 12, 13]);

    vi.advanceTimersByTime(60_000);
    expect(resyncRequests(ws)).toBe(1);
  });

  it("a residual hole after a served snapshot keeps retrying without new traffic", () => {
    const { ws } = openBridge();
    deliver(ws, snapshotMsg(10));
    deliver(ws, broadcastMsg(15)); // hole
    vi.advanceTimersByTime(PAST_GRACE_MS); // persists → request #1
    expect(resyncRequests(ws)).toBe(1);

    deliver(ws, snapshotMsg(12)); // served, but 13–14 are still missing
    vi.advanceTimersByTime(PAST_GRACE_MS); // drain → grace → request #2
    expect(resyncRequests(ws)).toBe(2);

    // Request #2 landed within ~1s of the served snapshot, so the server's
    // throttle may have eaten it. With no further inbound traffic, only
    // the retry timer can save the buffered tail.
    vi.advanceTimersByTime(5000);
    expect(resyncRequests(ws)).toBe(3);
  });

  it("snapshot adoption clears a leftover grace window so a new hole gets full grace", () => {
    const { ws } = openBridge();
    deliver(ws, snapshotMsg(10));
    deliver(ws, broadcastMsg(14)); // hole → grace armed
    vi.advanceTimersByTime(100); // half the window elapses...
    deliver(ws, snapshotMsg(14)); // ...then the (Lagged-pushed) snapshot repairs it

    deliver(ws, broadcastMsg(16)); // NEW hole (15 in flight) right after adoption
    // Inside the fresh window — a leftover timer would have fired by now
    // and pushed a premature request straight into the server's throttle.
    vi.advanceTimersByTime(150);
    expect(resyncRequests(ws)).toBe(0);

    deliver(ws, broadcastMsg(15)); // benign reorder resolves it
    vi.advanceTimersByTime(1000);
    expect(resyncRequests(ws)).toBe(0);
  });

  it("a requested snapshot arriving after late broadcasts caught tracking up does not rewind", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10));
    deliver(ws, broadcastMsg(15)); // hole → buffered
    vi.advanceTimersByTime(PAST_GRACE_MS); // persists → request
    expect(resyncRequests(ws)).toBe(1);
    for (let seq = 11; seq <= 14; seq++) {
      deliver(ws, broadcastMsg(seq)); // late arrivals: no actual loss
    }
    // 11–14 applied as they arrived; 15 drained from the buffer.
    expect(appliedSeqs(handlers)).toEqual([11, 12, 13, 14, 15]);

    // The requested snapshot raced the late broadcasts and reflects seq 12
    // — strictly older than our applied state. It must be skipped, not
    // adopted (adopting would rewind the document to the seq-12 state).
    deliver(ws, snapshotMsg(12));
    expect(handlers.onSnapshot).toHaveBeenCalledTimes(1); // join snapshot only

    deliver(ws, broadcastMsg(16));
    expect(appliedSeqs(handlers)).toEqual([11, 12, 13, 14, 15, 16]);
    expect(resyncRequests(ws)).toBe(1);
  });

  it("a reconnect resets tracking: the fresh snapshot re-baselines and no stale resync leaks over", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10));
    deliver(ws, broadcastMsg(14)); // gap on the old transport
    vi.advanceTimersByTime(PAST_GRACE_MS);
    expect(resyncRequests(ws)).toBe(1);

    ws.onclose?.();
    vi.advanceTimersByTime(2500);
    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(ws2).not.toBe(ws);
    ws2.open();

    deliver(ws2, snapshotMsg(0));
    deliver(ws2, broadcastMsg(1));
    vi.advanceTimersByTime(1000);

    expect(appliedSeqs(handlers)).toEqual([1]);
    expect(resyncRequests(ws2)).toBe(0);
  });

  it("a gap pending at destroy() neither throws nor transmits", () => {
    const { bridge, ws } = openBridge();
    deliver(ws, snapshotMsg(10));
    deliver(ws, broadcastMsg(14)); // arms the grace timer
    bridge.destroy();
    vi.advanceTimersByTime(10_000);

    expect(resyncRequests(ws)).toBe(0);
  });

  it("the gap buffer caps at its bound and sheds the lowest seqs (the snapshot covers those first)", () => {
    const { ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(0));
    // 4098 gapped entries (seq 1 missing throughout): two more than the
    // 4096 cap, so the two lowest (2 and 3) are shed on overflow.
    for (let seq = 2; seq <= 4099; seq++) {
      deliver(ws, broadcastMsg(seq));
    }
    vi.advanceTimersByTime(PAST_GRACE_MS);
    expect(resyncRequests(ws)).toBe(1);

    // Snapshot at 4097: everything retained at/below is covered-dropped;
    // the kept-highest tail (4098, 4099) applies. Had the shed dropped the
    // HIGHEST seqs instead, nothing above the snapshot would remain.
    deliver(ws, snapshotMsg(4097));
    expect(appliedSeqs(handlers)).toEqual([4098, 4099]);
  });
});

describe("Bridge pending local commands across snapshot full-replace", () => {
  beforeEach(() => {
    installFakeWebSocket();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const RENAME = { type: "rename_dataset", id: "wds-1", name: "Renamed" };
  const RENAME_JSON = JSON.stringify(RENAME);

  it("replays a sent-but-unacked command after a snapshot, and the ack retires it", () => {
    const { bridge, ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10, { "wds-1": {} }));

    // Optimistically applied by the caller (repo convention), then sent.
    const requestId = bridge.sendCommand(RENAME_JSON);
    expect(JSON.parse(ws.sent[ws.sent.length - 1])).toStrictEqual({
      type: "command",
      request_id: requestId,
      command: RENAME,
    });

    // The server built this snapshot BEFORE applying our command (its ack
    // is still in flight): full-replace would erase the optimistic local
    // effect, so the bridge replays it locally.
    deliver(ws, snapshotMsg(12, { "wds-1": {} }));
    expect(appliedCommands(handlers)).toEqual([RENAME_JSON]);

    // The ack lands (our command was sequenced at 13): pending retires.
    deliver(ws, ackMsg(13, requestId));
    deliver(ws, snapshotMsg(13, { "wds-1": {} }));
    expect(appliedCommands(handlers)).toEqual([RENAME_JSON]); // no second replay
  });

  it("accepted tradeoff: a snapshot outrunning our ack replays our stale value over the newer peer value it carried (local-only, bounded by the next edit/snapshot)", () => {
    // The premise behind pending replay — "the server built the snapshot
    // before applying our command" — loses a queue race: acks ride the
    // broadcast queue, snapshots ride the per-client unicast queue, so a
    // snapshot whose seq already COVERS our command (here seq 12 >= our
    // command's seq 11, and it carries a peer's even newer value for the
    // same entity) can arrive before our ack does.
    const OURS = JSON.stringify({ type: "rename_dataset", id: "wds-1", name: "Ours" });
    const { bridge, ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10, { "wds-1": { name: "Original" } }));
    const requestId = bridge.sendCommand(OURS); // sequenced server-side at 11; ack in flight

    // Peer renamed to "Theirs" at seq 12; the snapshot (built at 12) holds
    // the peer's value AND already reflects our seq-11 command. It arrives
    // ahead of our ack — the bridge cannot tell covered from pre-apply, so
    // it replays "Ours" over the snapshot's newer "Theirs".
    deliver(ws, snapshotMsg(12, { "wds-1": { name: "Theirs" } }));
    const snapshotDoc = (handlers.onSnapshot as ReturnType<typeof vi.fn>).mock.calls[1][1] as string;
    expect(JSON.parse(snapshotDoc)).toStrictEqual({ manifests: { "wds-1": { name: "Theirs" } } });
    expect(appliedCommands(handlers)).toEqual([OURS]); // the stomp

    // The late ack retires the pending entry but corrects nothing: no
    // further apply, no resync — the divergence stands, local-only, until
    // the next edit or snapshot converges it. This is accepted over the
    // alternative (skipping replay), which would erase the author's own
    // edit in the common pre-apply case.
    deliver(ws, ackMsg(11, requestId));
    expect(handlers.onAck).toHaveBeenCalledWith(11, requestId);
    expect(appliedCommands(handlers)).toEqual([OURS]);
    vi.advanceTimersByTime(1000);
    expect(resyncRequests(ws)).toBe(0);

    // Bounded: the retired entry is not replayed onto the next snapshot,
    // which re-delivers the converged document.
    deliver(ws, snapshotMsg(13, { "wds-1": { name: "Theirs" } }));
    expect(appliedCommands(handlers)).toEqual([OURS]); // no second replay
    expect(handlers.onSnapshot).toHaveBeenCalledTimes(3);
  });

  it("a command acked before the snapshot is not replayed", () => {
    const { bridge, ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10, { "wds-1": {} }));
    const requestId = bridge.sendCommand(RENAME_JSON);
    deliver(ws, ackMsg(11, requestId)); // retired
    deliver(ws, snapshotMsg(11, { "wds-1": {} })); // includes the command's effect

    expect(appliedCommands(handlers)).toEqual([]);
  });

  it("retires out-of-order acknowledgements by request id rather than send order", () => {
    const { bridge, ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10, { "wds-1": {} }));
    const first = bridge.sendCommand(
      JSON.stringify({ type: "rename_dataset", id: "wds-1", name: "first" }),
    );
    const second = bridge.sendCommand(
      JSON.stringify({ type: "rename_dataset", id: "wds-1", name: "second" }),
    );

    // A later command's outcome can overtake the earlier one. Its seq waits
    // behind the normal gap discipline, but correlation still retires the
    // correct optimistic command immediately.
    deliver(ws, ackMsg(12, second));
    deliver(ws, ackMsg(11, first));
    deliver(ws, snapshotMsg(12, { "wds-1": {} }));

    expect(handlers.onAck).toHaveBeenNthCalledWith(1, 12, second);
    expect(handlers.onAck).toHaveBeenNthCalledWith(2, 11, first);
    expect(appliedCommands(handlers)).toEqual([]);
    expect(resyncRequests(ws)).toBe(0);
  });

  it("retires only the nacked command, surfaces it, and reconciles from a snapshot", () => {
    const onNack = vi.fn();
    const { bridge, ws, handlers } = openBridge({ onNack });
    deliver(ws, snapshotMsg(10, { "wds-1": {} }));
    const rejected = bridge.sendCommand(
      JSON.stringify({ type: "rename_dataset", id: "wds-1", name: "rejected" }),
    );
    const stillPendingJson = JSON.stringify({
      type: "rename_dataset",
      id: "wds-1",
      name: "still pending",
    });
    const stillPending = bridge.sendCommand(stillPendingJson);

    deliver(ws, nackMsg(rejected, "forbidden", "owner policy denied the change"));
    expect(onNack).toHaveBeenCalledWith({
      requestId: rejected,
      code: "forbidden",
      message: "owner policy denied the change",
      retryable: false,
    });
    expect(resyncRequests(ws)).toBe(1);

    // The authoritative replacement rolls back the rejected optimistic
    // command; only the unrelated command still awaiting an outcome replays.
    deliver(ws, snapshotMsg(10, { "wds-1": {} }));
    expect(appliedCommands(handlers)).toEqual([stillPendingJson]);
    deliver(ws, ackMsg(11, stillPending));
    deliver(ws, snapshotMsg(11, { "wds-1": {} }));
    expect(appliedCommands(handlers)).toEqual([stillPendingJson]);

    vi.advanceTimersByTime(6000);
    expect(resyncRequests(ws)).toBe(1);
  });

  it("pending commands are dropped on disconnect (an unacked command may never have reached the server)", () => {
    const { bridge, ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10, { "wds-1": {} }));
    bridge.sendCommand(RENAME_JSON);

    ws.onclose?.();
    vi.advanceTimersByTime(2500);
    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws2.open();
    deliver(ws2, snapshotMsg(20, { "wds-1": {} }));

    expect(appliedCommands(handlers)).toEqual([]);
  });

  it("a command handed to a non-OPEN socket is not tracked (it never reached the server)", () => {
    const handlers = makeBridgeHandlers();
    const bridge = new Bridge(handlers, "ws://test/ws/workspaces/w1");
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    // Socket still CONNECTING: Bridge.send drops the frame silently.
    bridge.sendCommand(RENAME_JSON);
    expect(ws.sent).toHaveLength(0);

    ws.open();
    deliver(ws, snapshotMsg(5, { "wds-1": {} }));
    expect(appliedCommands(handlers)).toEqual([]);
  });

  it("the pending list caps at its bound, shedding the oldest entries", () => {
    const { bridge, ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10, { "wds-1": {} }));
    for (let i = 0; i < 70; i++) {
      bridge.sendCommand(JSON.stringify({ type: "rename_dataset", id: "wds-1", name: `n${i}` }));
    }
    deliver(ws, snapshotMsg(12, { "wds-1": {} }));

    const replayed = appliedCommands(handlers);
    expect(replayed).toHaveLength(64);
    expect((JSON.parse(replayed[0]) as { name: string }).name).toBe("n6"); // 0..5 shed
    expect((JSON.parse(replayed[63]) as { name: string }).name).toBe("n69");
  });

  it("an expired outcome-orphan is pruned and later snapshots do not replay it", () => {
    const { bridge, ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10, { "wds-1": {} }));

    // Simulate a transport that lost both sides of the outcome. The orphan
    // must not replay forever (its worst case is a stale remove_dataset
    // deleting a re-opened dataset on a much-later snapshot).
    bridge.sendCommand(JSON.stringify({ type: "remove_dataset", id: "wds-1" }));
    vi.advanceTimersByTime(11_000); // well past the pending TTL

    // Two healthy commands afterwards. Their correlated acks retire them;
    // the expired orphan is pruned before the first new send.
    const requestA = bridge.sendCommand(
      JSON.stringify({ type: "rename_dataset", id: "wds-1", name: "a" }),
    );
    const requestB = bridge.sendCommand(
      JSON.stringify({ type: "rename_dataset", id: "wds-1", name: "b" }),
    );
    deliver(ws, ackMsg(11, requestA));
    deliver(ws, ackMsg(12, requestB));

    // A much-later snapshot replays nothing: the stale removal expired and
    // both healthy commands were retired by their own acks.
    deliver(ws, snapshotMsg(12, { "wds-1": {} }));
    expect(appliedCommands(handlers)).toEqual([]);
  });

  it("a replayed remove_dataset keeps the membership gate honest for later stale rebroadcasts", () => {
    const { bridge, ws, handlers } = openBridge();
    deliver(ws, snapshotMsg(10, { "wds-1": {} }));
    // We removed wds-1 locally and sent; the ack is in flight.
    bridge.sendCommand(JSON.stringify({ type: "remove_dataset", id: "wds-1" }));

    // Snapshot still contains wds-1 (built pre-apply): the replay re-runs
    // the removal locally AND the membership mirror must follow, so a
    // retained dataset_opened rebroadcast can't resurrect it.
    deliver(ws, snapshotMsg(12, { "wds-1": {} }));
    expect(appliedCommands(handlers)).toEqual([
      JSON.stringify({ type: "remove_dataset", id: "wds-1" }),
    ]);

    deliver(ws, broadcastMsg(12, datasetOpenedCmd("wds-1")));
    expect(appliedCommands(handlers)).toEqual([
      JSON.stringify({ type: "remove_dataset", id: "wds-1" }),
    ]);
  });
});
