# Correlating work across the browser/server boundary

Status: Accepted. [0050](0050-server-timings-reach-the-monitor.md) added a
connection generation to the key, because a run can outlive a socket.

## Context

The chunk path carried no id. A chunk request names a dataset, an image and a
key, and the binary response frame is a fixed layout routed on the composite key
with no spare bytes. So the server could say "a chunk took 800 ms" and the
browser "a chunk took 1.2 s", and nothing joined the two.
[0047](0047-trace-model-phases-runs-and-lifecycle-rows.md) settled on two tables
joined after the fact, on an id that travels outbound only on the JSON control
messages. This record fixes that id. It is wire format, which is expensive to
revisit.

## Decision

Chunk and asset requests carry `rid`, a correlation label. It is a required
`u32` from one per-connection counter shared by both message families, monotonic
and never reset within a connection, so `(connection, rid)` is unique. Runs do
not appear on the wire. The server does not know runs exist, and the client
derives a row's run from the row's own timestamps.

`rid` is not `request_id`, the existing per-interaction string on control
messages such as `open_remote_dataset`. `CONTEXT.md` defines both. The short name
is deliberate. On a chunk request of about 95 bytes, `,"rid":2558` adds 11 bytes,
about 12% more request traffic on a warm re-open of 2,559 chunks. Spelled
`"request_id"`, the key alone would cost more than the value it labels.

Dataset open reuses its existing `request_id`. The open's metadata reads are its
children, so the exporter has two join paths: `rid` for chunk and asset rows,
`request_id` for metadata-read rows.

The label also crosses the server-to-data-source hop on `ChunkFetch`, so a wait
behind the source-read cap is attributed to a request and not only to a client.
The generated-chunk queue gets no label. It is asynchronous fan-out with no
requester waiting on a specific item, and labelling it would need its own model
of causality.

When the client coalesces duplicate in-flight fetches, the first sender's `rid`
goes on the wire and every coalesced row stores that same `rid`. The many-to-one
join is then a plain equi-join, and the coalescing count is a count of rows per
`rid`.

The label shipped together with the server's table, because a label with nothing
on the other end cannot be tested.

## Rejected alternatives

- Derived identity: join on the composite key and its nth occurrence in the run,
  with no new bytes. That depends on two counters staying in lockstep. A client
  fetch timeout or a reconnect makes them diverge, which are the conditions a
  stall investigation runs under, and the join would still produce rows, just
  wrong ones.
- A string id, following the `request_id` convention or using a ULID or UUIDv7.
  These cost 19% to 55% more request traffic instead of 12%.
- A `u64`. Nobody sends four billion requests on one connection, and the shorter
  decimal form is the saving.
- An optional field. It buys a saving nobody asked for, costs a branching server
  path, and with `#[serde(default)]` a client that stopped sending it would
  degrade silently to `rid: 0` on every row. Required lets the wire goldens catch
  a missing key.
- A per-run counter. Runs are client-side, and the server has no concept of one.
- A counter per message family. A `rid` that is ambiguous until you also know the
  message type is not unique per connection.
- Labelling every client message. A label on a cursor update buys nothing.

## Consequences

Anything that resets the counter without starting a new connection generation
breaks the join silently. A new labelled message family extends the shared
counter rather than minting a parallel one.
