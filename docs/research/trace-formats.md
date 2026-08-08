# Research: trace formats for the pipeline performance monitor

Research ticket [#887](https://github.com/aelefebv/lucida/issues/887), under map [#885](https://github.com/aelefebv/lucida/issues/885).

**Question.** Should lucida's performance trace adopt an existing trace format instead of a bespoke
one? Facts first; the decision is downstream (but a recommendation is at the bottom, as asked).

Every claim below is followed back to the source that owns it — official docs, specs, or the
implementing source file. Where a number is my arithmetic rather than a cited fact, it says so.

---

## 0. The shapes lucida has to express

From the map (#885) and the code already in the repo:

| Shape | Where it comes from | Volume |
| --- | --- | --- |
| Short spans, chunk-level | fetch → decode → upload → render, per chunk | tens of thousands per run |
| Overlapping async work that is **not** a call stack | N in-flight fetches, decodes on workers, uploads batched per frame | continuous |
| Periodic counter series | queue depths, residency, fps, hit rate, evictions/sec (`lucida-web/src/pipeline/fetch/telemetry.ts`, `lucida-web/src/pipeline/upload/telemetry/*`) | ~1 Hz to per-frame |
| Cross-process correlation | browser ↔ Rust server `chunk_serve` / `dataset_open`, joined on a request label | one flow per chunk |
| Three emit sites | TypeScript (main + workers), Rust-in-wasm (`lucida-core`), Rust server (`lucida-server`, already on `tracing` per ADR 0012) | — |

Two constraints from the repo that shape everything downstream:

- **The server already uses `tracing`** with `FmtSpan::CLOSE`
  (`lucida-server/src/main.rs:167`, ADR `wiki/decisions/0012-logging-conventions.md`), so whatever
  format we pick, the server side wants to be a `tracing_subscriber::Layer`, not a rewrite.
- **lucida is not cross-origin isolated.** There is no COOP/COEP header anywhere in `lucida-web` or
  `lucida-server` (grep for `Cross-Origin-Opener`/`crossOriginIsolated` returns nothing). Per MDN,
  `performance.now()` is coarsened to **100 µs** in non-isolated contexts and 5 µs in isolated ones
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now)). This is a **clock**
  limit, not a format limit, and it applies to a bespoke format equally — but it means browser-side
  chunk spans shorter than ~100 µs are unresolvable today regardless of what we serialize into.
  Enabling COEP/COOP to get 5 µs would be a separate, load-bearing decision.

---

## 1. Chrome Trace Event Format (JSON)

**Spec:** <https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview>
(the canonical "Trace Event Format" doc). Reference implementation of the legacy viewer is
catapult/trace-viewer, "the javascript frontend for Chrome about:tracing and Android systrace"
(<https://chromium.googlesource.com/catapult/+/HEAD/tracing/README.md>).

### What it can express

Per the spec, each event is a JSON object with `name`, `cat`, `ph`, `ts` (**microseconds**), `pid`,
`tid`, `args`. The phase (`ph`) character selects the semantics. The set that matters here:

| `ph` | Meaning | Covers |
| --- | --- | --- |
| `B` / `E` | Duration begin/end, stack-like on a (pid,tid) | nested sync work |
| `X` | Complete event (one record, with `dur`) | short chunk spans — half the bytes of B+E |
| `b` / `n` / `e` | Nestable async begin/instant/end, keyed by `id` | **overlapping work that is not a call stack** |
| `C` | Counter — `args` is a map of series-name → number | **queue depth, residency, fps** |
| `s` / `t` / `f` | Flow start / step / finish, keyed by `id` | **cross-process correlation** |
| `i` | Instant | point markers |
| `M` | Metadata (`process_name`, `thread_name`, sort index) | naming the lanes |

Two container forms: a bare JSON array of events, or an object with a `traceEvents` key (plus
`displayTimeUnit` and other top-level metadata).

`pid`/`tid` are just integers — nothing requires them to be real OS ids. The idiomatic move is to
mint one "process" per lane (browser main, each worker, wasm, server) and one "thread" per sub-lane.
Flow events then stitch a chunk's browser-side request to the server's `chunk_serve` span.

### What it cannot express, cleanly

- **Non-nested overlapping duration events on the same track.** Perfetto's importer documents this
  explicitly: "Perfetto's data model requires duration events (`B`/`E` pairs and `X` events) to
  nest… Overlapping, non-nested events… are kept visible by laying them out on a separate overflow
  track" (<https://perfetto.dev/docs/getting-started/other-formats>). Confirmed in the parser: the
  `X` branch calls `slice_tracker->Scoped(...)` and, on overlap, spills to an overflow track
  (`src/trace_processor/importers/json/json_trace_parser.cc`). **Mitigation:** put overlapping work
  on async (`b`/`e`) tracks or give each concurrent lane its own `tid`. This is a modelling
  discipline we'd have to hold, not a blocker.
- **No first-class "this counter belongs to that span"** relation. Counters are their own track.
- **Long-tail features are approximate.** Perfetto: "Support for some less common or highly specific
  features of the JSON format might be limited"; it "does not attempt to replicate specific
  rendering quirks or undocumented behaviors of the legacy `chrome://tracing` tool"
  (same page). Stick to the table above and this doesn't bite.

### What it buys for free — is the Perfetto UI real, or a trap?

**Real.** Verified against the Perfetto sources, not just marketing:

1. **Perfetto ingests Chrome JSON.** It is item 1 on the supported-formats list
   (<https://perfetto.dev/docs/getting-started/other-formats>), and the parser handles every phase
   lucida needs — `B`, `E`, `X`, `b`/`e`/`n`, **`C` → `PushProcessCounterForThread`**, `i`/`I`/`R`,
   **`s` → `flow_tracker->Begin`, `t` → `Step`, `f` → `End`**, `M` for thread/process names
   (`src/trace_processor/importers/json/json_trace_parser.cc`). So counter tracks and flow arrows
   both survive the JSON round-trip. This was the specific thing worth checking, and it holds.
2. **Both container forms, and truncated arrays, are accepted.** The tokenizer sets
   `format_ = *next == '{' ? kOuterDictionary : kOnlyTraceEvents`, and its end-of-input validation
   allows still being inside an unclosed array
   (`src/trace_processor/importers/json/json_trace_tokenizer.cc`). **A crashed or force-stopped
   recording still opens.** That is a genuinely useful property for a recording-first monitor.
3. **The UI can be embedded in lucida's own page.**
   `<iframe src="https://ui.perfetto.dev/#!/?mode=embedded">`, then a `PING`/`PONG` handshake and
   `postMessage({perfetto: {buffer, title, ...}})`
   (<https://perfetto.dev/docs/visualization/embedding-the-ui>,
   <https://perfetto.dev/docs/visualization/embedding-api-reference>). `mode=embedded` "fully
   disables the sidebar (not just hides it)". The host can also drive it: scroll to a time range via
   `{perfetto: {timeStart, timeEnd, viewPercentage}}`, and URL params `visStart`/`visEnd`, `ts`/`dur`
   for slice selection, `query` to run SQL on load, `startupCommands`.
4. **Nothing is uploaded.** "The Perfetto UI is client-only and doesn't require any server-side
   interaction. Traces pushed via `postMessage()` are kept only in the browser memory/cache and are
   not sent to any server" (<https://perfetto.dev/docs/visualization/deep-linking-to-perfetto-ui>).
5. **Size is a non-issue at lucida's scale.** Perfetto's large-trace guidance puts the browser
   ceiling at runtime memory, "2GB is typical", with a 2–4× inflation over binary size
   (<https://perfetto.dev/docs/visualization/large-traces>). *My arithmetic:* an `X` event with a
   name, category, four args and a flow id serializes to roughly 150–250 bytes of JSON; 50,000 of
   them is ~10 MB. Three orders of magnitude of headroom.
6. **SQL over the trace comes free.** PerfettoSQL exposes `slice`, `counter`, `thread_track`,
   `process_track`, `flow`, `thread`, `process` tables, queryable from the UI's Query tab, the
   Python API, or the C++ library (<https://perfetto.dev/docs/analysis/perfetto-sql-getting-started>).

### Where it is a trap

- **Third-party origin.** `ui.perfetto.dev` is Google-hosted. The embedding doc notes untrusted
  origins get a consent modal, host pages must be `http(s)` not `file://`, and the host must avoid
  `Cross-Origin-Opener-Policy: same-origin`. That last one directly conflicts with ever enabling
  cross-origin isolation for the 5 µs clock — you can't have both the embedded iframe *and* COOP
  same-origin on the host page. Self-hosting the UI is offered as the escape hatch ("unless you
  self-host") but is an unquantified amount of static bundle to vendor.
- **It is a snapshot viewer, not a live one.** The embedding API has open-trace, navigate, select,
  and query — no append. A "live view = the trace so far" surface would mean re-posting the whole
  buffer and reloading the trace on each refresh. The map's requirement #4 (recording-first, live
  view renders the in-progress recording) is therefore **not** satisfiable by Perfetto alone.
- **It will never call out the bottleneck.** Requirement #6 (derived callouts: worst stage, top
  stalls) is lucida's own work no matter what.
- **`chrome://tracing` specifically:** catapult/trace-viewer is still the documented frontend for
  `about:tracing` (<https://chromium.googlesource.com/catapult/+/HEAD/tracing/README.md>), but it is
  browser-version-dependent, not embeddable, and Perfetto's importer explicitly declines to match
  its quirks. Treat Perfetto UI as *the* off-the-shelf viewer; treat `chrome://tracing` as an
  incidental bonus, not a target.

### Cost

- **Emit:** one `JSON.stringify` (or `serde_json` line) per event into a preallocated array, plus a
  string join at stop. No dependency in TS; `serde_json` is already a transitive dependency of the
  Rust workspace. Zero bundle weight in the browser.
- **Rust:** `tracing-chrome` exists (v0.7.2, 16.4M downloads — crates.io API) and emits `B`/`E` for
  `TraceStyle::Threaded`, `b`/`e` for `Async`, `i`, and `M`. But reading the source
  (<https://github.com/thoren-d/tracing-chrome/blob/master/src/lib.rs>): it **emits no `C` counter
  events**, its timestamps are `Instant`-relative to layer init (`self.start.elapsed()`), and it
  writes via `std::thread::spawn` (line 295) into a `std::fs::File` (lines 104, 272). All three are
  disqualifying here: no counters, no wall-clock anchor to align with a browser clock, and no
  wasm32-unknown-unknown story. **Use it as a reference implementation, not a dependency** — a
  bespoke ~150-line `Layer` writing the same phases into lucida's own sink is strictly better and
  not meaningfully more work.

### LLM legibility

Best of the four. A raw event is self-describing to a reader who knows what `ph` means:

```json
{"name":"chunk_fetch","cat":"fetch","ph":"X","ts":128340.5,"dur":8120,"pid":1,"tid":3,
 "args":{"chunk":"0/2/5/7","bytes":262144,"level":2}}
```

An agent can grep, `jq`, and filter it without a library. The `ph` single-letter codes are the one
piece of prior knowledge required, and it is one line of legend. **But** 50,000 of these will not
fit in a context window, so the derived-summary layer is required regardless — see §5.

---

## 2. Perfetto protobuf (native TrackEvent)

**Spec:** <https://perfetto.dev/docs/reference/synthetic-track-event> (how to hand-author a trace),
plus the `TrackEvent` proto.

### Expressiveness

Strictly a superset of the JSON format for our purposes: `TYPE_SLICE_BEGIN`/`TYPE_SLICE_END` for
nested slices, `TYPE_COUNTER` for counter tracks, `TYPE_INSTANT`, arbitrary tracks (`track_uuid`)
for overlapping async work, tracks associable with OS processes/threads, correlation ids to link
related events, and explicit clock-snapshot packets for multi-clock alignment. Interned strings and
delta-encoded timestamps make it far more compact than JSON.

### What it buys

The same Perfetto UI, but with a smaller file and a cleaner data model (native tracks instead of
`pid`/`tid` puns, and no overflow-track workaround for overlapping slices). Better fidelity at
scale.

### Cost — this is where it falls down for lucida

- **No usable emitter for the browser or for wasm.** crates.io (API query for `perfetto`) turns up
  `perfetto-sdk` / `perfetto-sdk-sys` (FFI bindings to the C++ SDK — not a wasm target),
  `perfetto` 0.0.0 (a placeholder), `perfetto-recorder` (native recording), and
  `tracing-perfetto-file` (v0.1.1, 22 downloads at time of writing — not a dependency to build a
  default-on subsystem on). Emitting protobuf from TypeScript means hand-rolling or pulling in
  protobuf.js/ts-proto and the generated `TracePacket` descriptors — real bundle weight for a
  default-on feature.
- **Opaque to an agent reading raw bytes.** Requires a decoder. Directly at odds with map
  preference #5 (agent surface = the same trace bytes as the GUI).
- **Its win is a size win, and lucida does not have a size problem.** ~10 MB of JSON is far under
  the 2 GB ceiling.

---

## 3. OpenTelemetry (traces + OTLP)

**Spec:** <https://opentelemetry.io/docs/specs/otel/trace/api/>, <https://opentelemetry.io/docs/specs/otlp/>.

### Expressiveness

The Span model: name, `SpanContext` (**16-byte TraceId, 8-byte SpanId**), parent, `SpanKind`,
start/end timestamps, attributes, **Links** (references to other spans, possibly in other traces),
Events (timestamped points inside a span), Status. Cross-process correlation is the thing OTel is
actually *for* — the browser and the server would share a TraceId, and the correlation label the map
already wants becomes a propagated span context. That part is a genuinely good fit.

Nesting is a tree, not a stack, so overlapping async work is expressible: sibling spans under a
common parent overlap freely.

### What it cannot express

**Counter series are not in the trace.** The trace API spec contains no notion of counters, metrics,
or time series. Metrics are a **separate OTel signal** with their own data model (Sum, Gauge,
Histogram, ExponentialHistogram), their own OTLP message types, and only a weak trace linkage via
exemplars carrying `trace_id`/`span_id`
(<https://opentelemetry.io/docs/specs/otel/metrics/data-model/>). So lucida's queue-depth / residency
/ fps series would live in a *second* artifact, and the map's "**one** trace artifact" requirement
breaks at the format level. That alone is close to disqualifying.

### What it buys

Almost nothing that lucida wants. There is **no viewer in the box** — OTel gives you a wire protocol
and expects a backend (Jaeger, Tempo, an APM vendor). Standing up a collector to look at a chunk
pipeline is a large amount of moving parts for a self-hosted, single-user viewer. The upside is real
but distant: if lucida ever needs to ship traces into someone's existing observability stack, OTLP
is the answer.

### Cost

- **Browser SDK is explicitly not ready.** The official getting-started page states: "Client
  instrumentation for the browser is **experimental** and mostly **unspecified**"
  (<https://opentelemetry.io/docs/languages/js/getting-started/browser/>). The minimum package set is
  `@opentelemetry/api` + `sdk-trace-web` + `sdk-trace-base` + `context-zone` + instrumentation
  packages — a multi-package dependency graph shipped into a default-on path.
- **Rust:** `tracing-opentelemetry` is the mature bridge and maps `tracing` spans to OTel spans with
  `otel.name`/`otel.kind`/`otel.status_code` overrides (<https://docs.rs/tracing-opentelemetry/>). It
  does list wasm-conditional deps (`js-sys`, `web-time`), so the layer itself can compile for wasm —
  but the *exporter* is the hard part, and `opentelemetry-otlp` in the browser means an HTTP/JSON
  POST to a collector you have to run.
- **Overhead:** the SDK does sampling, batching, and resource attribution per span. Heavier per-span
  than appending an object to an array, and harder to reason about under a hard overhead budget.

### LLM legibility

OTLP/JSON is verbose but decipherable: lowerCamelCase field names, `traceId`/`spanId` as
hex-encoded strings (explicitly not base64), 64-bit integers as decimal strings
(<https://opentelemetry.io/docs/specs/otlp/>). Nested under
`resourceSpans[].scopeSpans[].spans[]`, so ~4 levels of wrapper per span. Legible, but with a much
worse signal-to-token ratio than a flat Chrome-JSON event array.

---

## 4. The `tracing` ecosystem's export paths

| Path | Verdict |
| --- | --- |
| `tracing` + `FmtSpan::CLOSE` (today, `lucida-server/src/main.rs:167`) | This is a **log stream**, not a trace: no counter series, no cross-process ids, no machine-readable timeline. The map already says the monitor is a different tool. Keep it. |
| `tracing-chrome` | Right *format*, wrong *implementation* for us: no `C` counters, `Instant`-relative timestamps with no wall-clock anchor, `std::thread` + `std::fs::File` (src/lib.rs:295, 104, 272). Reference, not dependency. |
| `tracing-opentelemetry` | Mature, wasm-compilable, but drags in the whole OTel/collector world and still leaves counters out of the trace. |
| A bespoke `tracing_subscriber::Layer` | ~150 lines. Gets `#[instrument]` on existing server spans for free, emits into lucida's own sink in whatever format we pick, and lets us stamp the correlation label and a wall-clock anchor. |

The important insight: **`tracing` is the server's instrumentation API, and it is orthogonal to the
serialization format.** Keeping `tracing` server-side does not commit us to any of its off-the-shelf
exporters. Adopting Chrome JSON does not mean adopting `tracing-chrome`.

---

## 5. What agents can read — and why the summary layer is unconditional

All four candidates are GUI-shaped. Ranked for an LLM reading raw bytes:

1. **Chrome JSON** — flat array of self-describing objects; greppable, `jq`-able, no decoder.
2. **OTLP/JSON** — legible but deeply nested and token-hungry; counters live in a separate document.
3. **A bespoke JSON format** — as legible as we choose to make it, by construction.
4. **Perfetto protobuf** — needs a decoder; effectively unreadable raw.

But **legibility is not the binding constraint — volume is.** Tens of thousands of chunk spans is
tens of thousands of JSON objects, and no format choice changes that. The map's requirement #5
("agent surface = the same trace bytes") and requirement #6 ("derived callouts, not just rows") are
satisfied by shipping *both*: the raw artifact for drill-down, and a derived summary (per-stage
totals, p50/p95, top-N stalls, worst stage) that fits in a prompt. **The derived-summary layer has to
exist under every candidate.** It is not an argument for or against any of them.

One genuine asymmetry in Perfetto's favour: PerfettoSQL means an agent with `trace_processor`
available can ask arbitrary questions of the trace via SQL rather than parsing it
(<https://perfetto.dev/docs/analysis/perfetto-sql-getting-started>). That is a real capability, but
it needs a binary that lucida does not ship — and it applies equally to a Chrome-JSON trace, since
`trace_processor` ingests those.

---

## 6. Precedent

I looked for browser-side streaming/tiled-data viewers that solved this and found **no positive
precedent in the obvious places** — GitHub code search over `visgl/deck.gl` for `perfetto` and over
`google/neuroglancer` for `traceEvents` both return 0 hits. Viewers in this class ship gauges (fps
counters, memory HUDs), the same thing the map identifies as lucida's gap. That is a real finding:
this is under-solved territory, and there is no house style to conform to.

The nearest useful precedent is from the Rust rendering world rather than the viewer world:
**Bevy**, a Rust engine that also targets wasm, builds on `tracing` and offers two exports —
`trace_tracy` (Tracy, native only) and `trace_chrome`, where "a `json` file in the 'chrome tracing
format' will be produced. You can open this file in your browser using https://ui.perfetto.dev"
(<https://github.com/bevyengine/bevy/blob/main/docs/profiling.md>). Notably, Bevy's profiling doc
says nothing about wasm/browser profiling at all — the wasm side is exactly the gap lucida would be
filling itself.

Chrome's own compositor is the closest thing to a large-scale tiled-pipeline tracer, and it emits
Chrome trace events (e.g. `TRACE_EVENT1("cc", "RasterizerTaskImpl::RunOnWorkerThread", ...)` in
`cc/tiles/tile_manager.cc`). I checked whether that file uses `TRACE_EVENT_WITH_FLOW` for
cross-thread tile correlation and it does not — it correlates by passing a
`source_prepare_tiles_id` argument instead. Worth knowing: even the canonical user of the format
often correlates via an `args` key rather than flow events, and reads fine in the UI either way.

---

## 7. Comparison at a glance

| | Chrome JSON | Perfetto proto | OTel | Bespoke |
| --- | --- | --- | --- | --- |
| Nested spans | ✅ `B`/`E`, `X` | ✅ | ✅ | ✅ |
| Overlapping non-stack work | ⚠️ async `b`/`e`, or per-lane `tid`; overlapping `X` spills to overflow track | ✅ native tracks | ✅ sibling spans | ✅ |
| Counter series in the same artifact | ✅ `C` | ✅ `TYPE_COUNTER` | ❌ separate signal | ✅ |
| Cross-process correlation | ✅ `s`/`t`/`f` flows + shared id in `args` | ✅ | ✅✅ built for it | ✅ |
| Truncated/crashed recording opens | ✅ (tokenizer allows unclosed arrays) | ⚠️ | ❌ needs an exporter flush | ✅ |
| Off-the-shelf viewer | ✅ Perfetto UI, embeddable | ✅ Perfetto UI, embeddable | ❌ needs a backend | ❌ |
| Live/in-progress view | ❌ (re-post the buffer) | ❌ | ❌ | ✅ |
| Browser bundle cost | none | protobuf codec | multi-package SDK | none |
| Rust wasm emitter | trivial | none viable | layer yes, exporter no | trivial |
| Raw LLM legibility | good | none | fair | by construction |
| Bytes for ~50k events | ~10 MB (my estimate) | ~1–3 MB | ~30 MB+ | ~10 MB |

---

## RECOMMENDATION

**Adopt the Chrome Trace Event Format (JSON) as lucida's on-the-wire trace artifact. Emit it
ourselves. Treat the Perfetto UI as a free power-user surface, not as *the* visual surface.**

Concretely:

1. **Format.** The array form, restricted to a deliberately small vocabulary: `X` for completed
   spans, `b`/`e` for overlapping async work, `C` for counter series, `s`/`f` for cross-process
   flows, `M` to name lanes, `i` for markers. Write that vocabulary down as a lucida convention so
   the model stays disciplined and we never hit Perfetto's "less common features" caveat.
2. **Lanes.** Mint `pid`/`tid` per logical lane (browser main, each worker, wasm, server), named via
   `M` metadata events. Do not use real process ids.
3. **Clock.** One wall-clock-anchored monotonic epoch, with the server's `tracing` spans offset onto
   the browser clock via the correlation label. `ts` is microseconds — the format has more precision
   than the 100 µs `performance.now()` clamp gives us, so the format is not the limiting factor.
4. **Emitters.** Three thin ones: a TS sink (append objects to an array; no dependency), a wasm sink
   in `lucida-core`, and a bespoke `tracing_subscriber::Layer` on the server that reuses the existing
   `#[instrument]` spans. **Do not depend on `tracing-chrome`** — read it, don't import it.
5. **Surfaces.** lucida owns the primary visual timeline (it has to: live-in-progress and derived
   callouts are both outside what Perfetto will do for us) and owns the derived summary for agents
   (required under every candidate). Add an **"Open in Perfetto"** action that posts the same
   `ArrayBuffer` to an embedded `mode=embedded` iframe or a new tab. That is a few dozen lines for a
   full-fidelity deep-dive viewer with SQL, and it costs nothing if nobody clicks it.

### The tradeoffs I am accepting

- **The overlapping-`X` overflow-track quirk.** Real, documented, and avoided by modelling
  discipline (async phases / per-lane tids). Cheaper than adopting protobuf to dodge it.
- **JSON is ~5× the bytes of protobuf.** At ~10 MB per run this is free. It would not be at 500 MB.
- **A single-letter `ph` vocabulary is slightly obscure.** Offset by one legend line, and by the fact
  that every other property (grep-ability, zero deps, an existing viewer) follows from it.
- **We build the primary timeline anyway.** Adopting an existing *format* does not save us from
  building a *surface*. What it saves is inventing a schema, and it buys a second viewer, a SQL
  engine, and a corpus of tooling that already understands our bytes.
- **Perfetto UI is a third-party origin.** Mitigated by making it opt-in-per-click, and by the
  documented self-hosting escape hatch if that ever matters. Note the conflict: embedding it forbids
  `COOP: same-origin` on the host page, which is the same header we'd need for a 5 µs clock. If
  timer resolution ever becomes the binding constraint, open Perfetto in a new tab instead of an
  iframe.

### What would change my mind

- **Traces routinely exceeding ~100 MB / several hundred thousand events.** Then Perfetto protobuf's
  interning and delta encoding start paying for their tooling cost. Measure this in the trace-model
  prototype before committing.
- **A requirement to ship traces into an existing observability backend** (someone deploying lucida
  wants its spans in their APM). Then OTLP, and counters move to the metrics signal. Nothing here is
  hard to re-target: the emit sites are the investment, the serializer is a leaf.
- **The overflow-track behaviour turning out to be pervasive rather than avoidable** in a real
  recording of a dataset open. If the async-track modelling gets contorted, native Perfetto tracks
  are the honest answer.
- **`performance.now()`'s 100 µs clamp swallowing most chunk spans.** That is a clock problem, not a
  format problem, but it would reshape the whole monitor (aggregate counts instead of per-chunk
  spans) and is worth measuring first.
