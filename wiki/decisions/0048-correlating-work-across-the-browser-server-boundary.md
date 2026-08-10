---
type: Decision
title: "Correlating work across the browser/server boundary"
description: "A per-connection monotonic u32 `rid`, minted by the client and shared by chunk and asset requests, is the join key between the browser's lifecycle table and the server's."
tags: [lucida, decision]
source_path: wiki/decisions/0048-correlating-work-across-the-browser-server-boundary.md
created: 2026-08-10
modified: 2026-08-10
---

# Correlating work across the browser/server boundary

Status: Accepted

Context: issue [#890], under the [#885] map. Constrained throughout by
[0047](0047-trace-model-phases-runs-and-lifecycle-rows.md), which fixes what a
record is; volumes from [#888], rates from [#899].

[#885]: https://github.com/aelefebv/lucida/issues/885
[#888]: https://github.com/aelefebv/lucida/issues/888
[#890]: https://github.com/aelefebv/lucida/issues/890
[#899]: https://github.com/aelefebv/lucida/issues/899

## Terms

**Correlation label** (`rid`) — the identifier that joins a browser-side lifecycle
row to the server-side row for the same wire request. Distinct from **request id**
(`request_id`), the pre-existing per-interaction identifier on control messages
such as `open_remote_dataset` and `dataset_health`. Both are in `CONTEXT.md`; they
are different shapes with different lifetimes and must not be conflated.

## The situation

Neither side can name the other's work. `ChunkMessage::ChunkRequest` carries
`{ dataset_id, image_id, key }` and nothing else — there is no id anywhere in the
chunk path. The response is a binary frame, `[client_id u32][key_len u16][key]
[data]`, routed on the composite key string `{dataset_id}/{image_id}/{chunk_key}`,
which the client's pending map is keyed on as well. So the server can say "a chunk
took 800 ms" and the browser can say "a chunk took 1.2 s", and nothing joins the
two sentences.

[0047](0047-trace-model-phases-runs-and-lifecycle-rows.md) already settled the
shape of the answer — two tables, joined after the fact on an outbound-only
correlation id — because the binary frame has no spare bytes and the control
messages are `serde_json`. What is left is everything that makes that
implementable, and all of it is wire format, which is the expensive kind of
decision to revisit.

## The label is a field, not derived identity

The tempting free option is no new bytes at all: join on `(composite_key,
nth-occurrence-within-run)`, since the server already receives the composite key
and knows its own arrival order.

It was rejected because it is a correctness argument resting on two independent
counters staying in lockstep, and they can diverge. The client's fetch timeout
removes a pending entry the server may still be serving, and reconnect fails every
pending request while the server's state is untouched — after either, the two
sides are counting different sequences for the same key. Those are precisely the
conditions a stall investigation runs under. A trace that silently mis-attributes
under the failure it exists to diagnose is worse than no trace, and the failure is
invisible: the join still produces rows, just wrong ones.

## `rid`: a required per-connection monotonic `u32`

**Integer, not string.** The house pattern for `request_id` is a `String`, but
every existing user of it is a once-per-interaction control message where the
bytes are free. This is the one family where they are not. Against the real
fixture envelope (95 B) and [#888]'s expensive case (warm re-open, 2,559 chunks
≈ 237 KiB of request traffic):

| form | bytes/msg | warm re-open | overhead |
|---|---|---|---|
| `,"rid":2558` | +11 | +27 KiB | **+12%** |
| `,"request_id":2558` | +18 | +45 KiB | +19% |
| ULID / base32-26 | +42 | +105 KiB | +44% |
| UUIDv7 hex string | +52 | +130 KiB | +55% |

**The short field name is the point of the name.** At this volume `"request_id"`
costs more than the value it labels — 18 KiB of the 45 is the key. That is worth
one deliberate inconsistency with the control-message convention, and the
inconsistency is not merely cosmetic: these genuinely are different things, so
sharing a name would be the more misleading choice.

**`u32`, not `u64`.** Four billion requests on one connection is not a bound
anyone reaches, and the shorter decimal form is the whole saving.

**Required, not `Option`.** The opt-out from [#885] governs *recording*, not
emission: 11 bytes on a 95-byte message is not what anyone opts out of. Optionality
would buy a saving nobody asked for and cost a permanently-branching server path,
plus a `#[serde(default)]` that lets a client which stops sending the field degrade
silently to `rid: 0` on every row. Required means the golden-fixture required-key
harness catches that loudly, which is the behaviour a join key should have.

**Per-connection, monotonic, never reset within a connection.** Not per-run: a run
is a client-side interval over a continuous buffer, and the server has no idea runs
exist. Pushing a purely client-side concept onto the wire buys nothing, and the
trace header already records the connection, so `(connection, rid)` is globally
unique and the run is derived client-side from the row's own timestamps. Server
rows are therefore keyed `(client_id, rid)`, `client_id` being what the server
already has.

**One counter shared by chunk and asset requests.** Per-connection uniqueness means
uniqueness across the connection, not within a message family — a `rid` that is
ambiguous until you also know the message type is not the thing that was decided.
Sharing also collapses the two server tables into one with a family column. The
cost is gaps in the chunk `rid` sequence where assets were requested, which is
harmless because nothing derives order from contiguity.

## What carries a label

Chunk requests and asset requests get `rid`. Dataset-open **reuses the existing
`request_id`** rather than growing a second identifier: `OpenRemoteDataset` already
carries one the server threads through the open, and [0047]'s metadata-read table
is one row per read *under* one open — so `request_id` is already the parent and
the reads are already its children. The exporter carries two join paths as a
result, which is a dozen lines; two ids on one message would be a permanent
ambiguity every future reader has to re-resolve.

Labelling *every* `ClientMessage` was rejected as uniformity for its own sake: a
label on `client_cursor` buys nothing and pays goldens churn across ~20 fixtures.

## The label reaches `ChunkFetch`, but not the generated queue

`ChunkMessage::ChunkFetch` — server to data source — is on the critical path of
the exact thing the monitor exists to explain. [#899]'s headline finding is that
the fetch rate is set by a process-global 12-permit source-read semaphore, and the
permit wait happens behind this hop. Without the label there, the server's own
table cannot attribute a permit wait to a request.

This means the server's phase enum reaches past enqueue on the source path.
[0047] says the enum "stops at enqueue" — that was about socket write time, which
happens in a separate task behind an unbounded queue and genuinely is not
observable from the serve path. The source-read hop is observable and is the
interesting part. Noting it here so the difference reads as deliberate.

The generated-chunk queue does **not** get a label. It is asynchronous fan-out
with no requester waiting on a specific item, so labelling it would need its own
causality model.

## Coalescing: first sender's label, copied to every row

The client coalesces duplicate in-flight fetches on the composite key — the first
caller sends, later callers attach to the same pending entry and never send.
[0047] fixed the join as many-to-one but not the mechanism.

The first sender's `rid` goes on the wire, and **every coalesced row stores that
same `rid`**. The many-to-one then falls out of the data: the join is a plain
equi-join with no redirect field and no special case. This also supplies [0047]'s
"counter on wire-level coalescing" for free — the coalescing count is
`count(rows) group by rid`, so no separate counter is needed.

## Blast radius

Small on the wire, and deliberately not small in behaviour.

Touched: `ChunkRequest` / `AssetRequest` / `ChunkFetch` in
`lucida-core/src/protocol.rs`; the fixtures `wire-fixtures/session/chunk_request.json`
and `asset_request.json`; the two required-key pointer lists in
`lucida-server/tests/wire_goldens.rs`; the emit sites in
`lucida-web/src/pipeline/fetch/contentSource.ts`; and the vitest mirrors in
`wireGoldens.test.ts` and `contentSource.test.ts`.

Not touched: the binary response frame; `lucida-proxy`'s `LPRX` asset header;
`lucida-py`, which never sends chunk requests; and `vocab/enum_vocabulary.json`,
since no enum gains a variant. Per the repo's no-back-compat rule this is a clean
format change with no tolerance window.

**The label ships with the server table, not before it.** [#885] flagged that the
server side was under-scoped when the map was charted, and it was right:
`lucida-server`, `lucida-store` and `lucida-content` contain exactly one
`#[tracing::instrument]` between them, so there is no server-side table for the
label to key into. A correlation label with nothing on the other end is
untestable — it would land as a field nobody reads, and the first act of whoever
built the server table would be to change it. The two are one piece of work.

## Consequences

- `(connection, rid)` is the trace's global key. Anything that resets the counter
  without starting a new connection breaks the join silently.
- Adding a labelled message family means extending the shared counter, not minting
  a parallel one.
- `rid` and `request_id` coexist and mean different things. The naming is load-bearing;
  `CONTEXT.md` records both so the distinction survives the people who made it.
- The exporter has two join paths — `rid` for the chunk/asset tables, `request_id`
  for the dataset-open table.
