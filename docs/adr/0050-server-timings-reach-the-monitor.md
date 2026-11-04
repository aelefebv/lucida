# How server-side timings reach the monitor

Status: Accepted. Amended by [#1048], which added two opt-in paths off the page.

## Context

[0047](0047-trace-model-phases-runs-and-lifecycle-rows.md) gave the server its
own lifecycle rows and [0048](0048-correlating-work-across-the-browser-server-boundary.md)
the `rid` that joins them to the browser's, but neither said how server rows
reach the trace. Before this, server timing was only `tracing` span-close lines
in the log ([0012](0012-logging-conventions.md)), on one instrumented flow.

## Decision

The browser owns the merged trace. Server rows travel to the client whose
requests produced them. There is no server-side trace store or endpoint.

The server pushes rows in batches over the existing session socket, every
250 ms, with an early flush at 512 buffered rows (`lucida-server/src/timing.rs`).
At about 82 reads/s remote and 894/s local ([#899]), a batch is 20 to 220 rows,
four messages a second, and the lag is small beside queue waits measured in
seconds. The server holds one flush window per connection, never a session.
Emission is unconditional, like recording
([0049](0049-unconditional-recording-under-a-design-budget.md)).

A batch is one message of parallel column arrays, which the browser copies
into its table without allocating inside the recorder's zero-allocation budget.
A family column covers chunk, asset and metadata-read rows. Chunk and asset rows
key on `rid`, metadata-read rows on the open's `request_id`.

Server rows are placed by nesting, not clock synchronisation. They carry
durations relative to their own arrival, never a wall-clock time. The browser
stamps the send and the receipt of each `rid` on one clock, and the exporter
places the server's work inside that bracket, showing the remainder (network
plus socket queue) as a named gap. The server's clock is never trusted, so skew
cannot draw a wrong picture.

A client receives rows for its own requests only, including its own wait for a
source-read permit, and no process-wide aggregate. The read cap is shared by
every client in the process, so queue depth and peer rates would leak a signal
across workspaces without answering any question the client's own wait does not.

The source cache coalesces too: it elects a single-flight leader per object and
parks the other readers. A follower's row records its wait under a coalesced-wait
phase and names the leader's `rid`, and only the leader's row owns the permit
wait and the backend read. Each backend round trip is counted once, and a
follower's wait does not read as a slow backend.

The server's phase enum is finer than the browser's, because the 100 µs floor in
0047 is a browser-platform limit and Rust's `Instant` has none. Binding lookup
gets a slot because it takes the shared session mutex. The server inherits
0049's per-event ceiling but not its tick ceiling, which needs a frame loop.

`rid` restarts on a new connection and the browser reconnects within seconds, so
one run can span connections. Browser rows carry a connection generation, and
the run header lists the connections a run spanned. Rows the server buffered for
a dead connection are discarded, because replay would need retention across
connections. The browser knows it reconnected, so the browser declares the gap.

Both sides drop and count. The server's pre-flush buffer stops at 1,024 rows
and reports what it dropped in the next batch. In the browser, server rows share
the recorder's caps, and after a run truncates, arriving server rows are dropped
but counted, so coverage is not overstated for one side.

A not-ready answer to a generated-chunk request ends the server row, but no chunk
ever arrives. The exporter must not read that browser row as a server stall.

Two opt-in paths carry data away from the page
([0051](0051-the-trace-driver-and-the-page-export-seam.md)), and neither is a
trace store. The inbox keeps bundles people sent, for 14 days. The relay
forwards aggregates from pages with the watch toggle on, with a small ring for
late subscribers. The server computes nothing over either and writes no row of
its own.

## Rejected alternatives

- A server-side trace store and endpoint, or merging two saved files offline.
  Either moves the run header, retention and truncation record off the browser,
  and an offline merge gives the live view nothing. `lucida trace` drives a
  browser, so no agent path wants server rows without one.
- The client pulls a batch at the end of a run. The server does not know runs
  exist, so it cannot tell when one ends, and it would have to retain a session.
- One message per served row. A single burst of 2,943 chunk requests ([#888])
  would double server-to-client message count on the path being measured.
- Anchoring server times on one clock with a measured offset. It draws a
  confident, wrong timeline whenever the estimate drifts. Comparing durations
  alone cannot place server work at all.
- Metadata reads on `DatasetOpenProgress`, whose stages are user-facing and
  should not be tied to the trace schema, or on the open's success message,
  which loses them on a failed open, where they matter most.

## Consequences

A change to the source cache's single-flight scheme changes the trace's
arithmetic. Server work not nested in a browser-measured request, such as a
server-initiated chunk push, cannot be placed and would need its own clock rule.

[#888]: https://github.com/aelefebv/lucida/issues/888
[#899]: https://github.com/aelefebv/lucida/issues/899
[#1048]: https://github.com/aelefebv/lucida/issues/1048
