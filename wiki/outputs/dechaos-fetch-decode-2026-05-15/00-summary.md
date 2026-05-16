# Dechaos: fetch/decode subsystem — summary

Date: 2026-05-15. Scope: `lucida-web/src/pipeline/{cpuCache,contentSource,decodePool,decode.worker}.ts` + `bridge.ts` binary routing. Mirrors the recently-completed dechaos+code pass on the planning subsystem.

## TL;DR

The subsystem is **functionally healthy** (well-tested at the public surface, no obvious correctness defects), but `cpuCache.ts` is the textbook god-object: 1627 LOC, 35 fields, 12 distinct concerns. It needs the same kind of decomposition the planning module just received (1500-LOC file → directory of 100–500 LOC files).

The proposed plan is **11 incremental slices** in dependency order, mirroring the planning refactor's cadence. No public-API change; integration tests stay green throughout. Two real bugs surface naturally and get fixed mid-refactor: an `imageWireFormats` leak on dataset removal, and an error-classification bug where "no wire format registered" is misclassified as transient and retried.

## Per-pass outputs

1. [01-system-map.md](01-system-map.md) — what's in scope, who calls in/out, where each concern lives today.
2. [02-boundary-scan.md](02-boundary-scan.md) — 12 candidate seams, ranked by severity. Top three: chunk/proxy duplication, scheduler-vs-store tangle, telemetry counter scatter.
3. [03-responsibility-scan.md](03-responsibility-scan.md) — `cpuCache.ts` owns 12 named responsibilities; `submit/fetchAndDecode/cancelDataset/telemetry` each fuse multiple phases. Other files (decode.worker, contentSource impl) are healthy.
4. [04-dependency-scan.md](04-dependency-scan.md) — wrong-direction `extractDataType` import; 16 telemetry counter fields scattered; `imageWireFormats` never cleared (leak); single-impl `ContentSource` despite multi-variant `FetchSource`.
5. [05-contract-scan.md](05-contract-scan.md) — failure shape is "anything thrown" + brittle string-matched classification; `ReadyDelivery.kind?` is an optional discriminator footgun; `telemetry()` is a side-effecting getter; verified `lane: "proxy"` is unused and plan IS sorted by priority.
6. [06-composability-scan.md](06-composability-scan.md) — extractable units: dedup-ladder, active-set diff, fetch-and-decode happy path, scheduler loop, eviction policies, interaction-mode detector, telemetry counters, retry policy, burst logger, debug dumps. Highest-payoff (and highest-risk) is the chunk/proxy `Scheduler<Req, Result>` unification — defer.
7. [07-testability-scan.md](07-testability-scan.md) — `cpuCache.test.ts` (68 tests, 1427 LOC) is excellent integration coverage; **zero direct unit tests** for decodePool, contentSource, decode.worker, or bridge. Pre-refactor: add ~250 LOC of new tests for wire protocol, decoders, content source, and characterization gaps (cancelled-during-decode race, backpressure log, imageWireFormats leak).
8. [08-refactor-sequencing.md](08-refactor-sequencing.md) — 11 slices ordered by precondition. Slice 0 = mechanical move. Slice 1 = pre-refactor tests. Slices 3-9 = sub-module extractions. Slice 10 = `cpuCache.ts` becomes ~250-LOC coordinator. Two deferred slices (chunk/proxy unification; `ContentSourceFactory`) wait for explicit triggers.

## Two bugs surfaced

1. **`imageWireFormats` leak.** `ProxiedContentSource.imageWireFormats` is never cleared on dataset removal. Long-running sessions with many open/close cycles accumulate wire-format entries forever. Small leak per dataset; harmless short-term, real long-term. Fixed in Slice 4.

2. **"No wire format registered" misclassified as transient.** `fetchAndDecode` classifies error as permanent only if the message contains `"404"` or `"malformed"`. The "No wire format registered for image X" rejection from `ContentSource.fetch` matches neither, so it's retried once and then enters the failures map for one content epoch. Almost certainly not the intended behavior — it's a setup bug, not a network blip. Fixed in Slice 8 by introducing typed `FetchError(kind: "permanent" | "transient" | "abort")` and having `ProxiedContentSource` raise the right kind.

A possible third issue (cancelled-during-decode race) needs verification. Pass 5 found that a fetch which resolves and decodes after `cancelDataset` lands in both the cache *and* the `ready[]` queue. Slice 1's characterization test pins the behavior either way — fix or document.

## Estimated effort

~11 PR-days for slices 0-10. Defer slice 11 (5-line bridge cleanup) to opportunism. Defer slices 12-13 indefinitely.

## Suggested next step

Hand this to `/code` to scope each slice into a PRD or ticket-level work item, OR run `/code` per-slice as the project cadence prefers. The planning refactor used a "PRD per slice" model with independently-gated validation checks; the same model works here.
