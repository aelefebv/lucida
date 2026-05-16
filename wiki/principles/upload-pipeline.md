---
created: 2026-05-16
modified: 2026-05-16
---

# Principles — Upload Pipeline

The upload pipeline is the CPU-thread side of the CPU → GPU hand-off: it consumes plan output and decoded cache entries and emits cold state, view-hot state, chunks, and proxies to the GPU worker, then handles the worker's eviction and wanted-set feedback. These principles describe what the upload pipeline optimizes for, and why. They are stable claims about *direction*; specific design choices are recorded as ADRs that cite these principles as their justification.

Principles are blind to decisions. They are read by — never read from — the rest of the wiki.

## 1. One hand-off path to the worker

The Uploader is the sole code surface that posts upload-side messages to the GPU worker — chunks, proxies, cold state, view-hot state, layer-resource removals. No parallel `postMessage` surface, no out-of-band sends from the Orchestrator, RenderLoop, slicePath, volumePath, or any other consumer.

**Why.** Two paths competing for the same worker contract — each maintaining its own residency, its own delivery tracking, its own staleness check — produce non-deterministic interleaving and "I sent it, why didn't it draw?" symptoms that are hard to attribute to either path. The cost of "one bug ruins everything" is accepted in exchange for the cost being attributable: bugs land in one place and have one regression test. Mirrors [[principles/cpu-cache#6-one-fetch-path-one-budget-one-failure-regime]] on the network side.

## 2. Cold state is the worker's authoritative worldview

Every chunk, proxy, and view-hot-state message the worker accepts is interpreted in the context of the most recent cold state for its dataset. Chunks arriving with a stale epoch are dropped at the worker boundary; chunks arriving before any cold state has no atlas to bind to. The Uploader pairs every cold-state emission with a delivery-tracker reset because the worker is rebuilding atlases.

**Why.** Without an authoritative reference point, "what should the atlas hold?" becomes a question with no single answer — the worker would maintain its own state and the main thread would maintain its own, and the two would drift. Anchoring on the cold state means residency is a function of one timestamped truth, and stale work falls out of the system harmlessly via the epoch staleness check rather than via complicated reconciliation.

## 3. The byte budget is soft, not hard

`Uploader.deliverToWorker` runs to budget exhaustion: the first chunk whose transfer pushes `remaining` below zero is still sent, then the loop stops and the tick is marked `budgetExhausted`. Better to overshoot by one chunk than to drop one that's already paid for (network + decode) because of a few bytes' overage.

**Why.** A hard cap forces "stash and retry next tick" for the overshooting chunk, which means another tick of cache pressure for a chunk that's ready to go right now. The soft cap honors the work already done; the budget remains a useful aggregate bound across many ticks while never gating an individual transfer that's already in hand. The same principle governs why the cache holds bytes after GPU eviction — see [[principles/cpu-cache#1-decoded-bytes-survive-gpu-eviction]].

## 4. Delivery tracking has one source of truth

`DeliveryTracker` owns chunk-sent state, chunk-rejected state, the entity-id reverse lookup (for cross-phase `markRejected` dispatch), and proxy-delivered state — behind intent-named methods (`markChunkSent`, `wasChunkSent`, `markChunkEvicted`, `markProxyDelivered`, `onColdStateRebuild`, `clearMember`, `clearDataset`). No parallel maps maintained on the Orchestrator, Uploader, or RenderLoop.

**Why.** The pre-refactor design had five parallel maps with implicit lifetimes, ambiguous key shapes (workerMemberId vs entityId vs dataset id), and scattered mutation sites. The combination produced silent bugs — the dead `workerWantedSet` field that the doc claimed was a filter, and the per-dataset-clear semantics that drifted from once-per-rebuild semantics — that were invisible because no single site owned the invariant. One typed surface means future state additions either land on the tracker (and inherit its lifecycle) or are surfaced as a deliberate exception. Bugs land where you'd look for them.

## 5. Per-dataset state is per-dataset

The Uploader and Orchestrator track last-tick chunk requests, proxy requests, entities, visible region, cached-key counts, and planning state per dataset, never as flat fields that silently collapse to last-processed-dataset semantics. The chunk and proxy resend passes iterate every dataset's entries; `clearMember(workerMemberId)` and `clearDataset(datasetId)` are typed operations with disjoint domains.

**Why.** Multi-dataset workloads (the explicit Slice 4 fix in PRD #607) revealed that flat-field state silently collapses to last-processed-dataset semantics — observable as "second dataset takes longer to recover from a transient eviction storm" and invisible to single-dataset testing. Per-dataset Maps from the start mean there's no shape to drift into; the resend pass is correct by construction; debug snapshots reflect every dataset, not whichever was last.

## 6. Worker → main feedback is bounded

`chunksEvicted` and `wantedSetDelta` arrive at any time but produce deterministic, bounded effects: evicted chunks become re-eligible for upload (no fresh fetch triggered); skipped chunks become rejected (one bounded notification to the cache via `markRejected`); missing proxies clear the delivered tracking so the next resend pass picks them up. No detector-of-anomalies that reactively storms the cache; no implicit retry built into the feedback path.

**Why.** The chunk pipeline runs at RAF cadence; a feedback handler that triggered a fresh fetch, eviction, or upload would create a closed loop that fights itself across frames. The Uploader's feedback handlers update tracking and call `cpuCache.markRejected` — which is itself bounded per [[principles/cpu-cache#5-failure-is-windowed-not-permanent]]. The next tick's natural plan + drain pass picks up where the worker's feedback left off, with the worker's latest residency state already reflected in the tracker.

## How these interact

Several of these principles trade against each other or compose:

- **Principles 1 (one hand-off) and 2 (cold state authority) together** define the worker contract: there is one path in, and what arrives is interpreted against one frame of reference. The pair gives the worker a tractable mental model — "what's in the atlas was sent by the Uploader against a cold state I have" — and gives the upload side a tractable inverse — "if I sent it against this cold state and the worker has that cold state, it's there."

- **Principle 3 (soft budget) refines Principle 1**: even with a single hand-off path, the budget bounds *aggregate* per-tick work without preventing the individual transfer that's already paid for. The pair avoids the failure mode where the single path becomes a bottleneck that drops perfectly good work.

- **Principle 4 (one tracker) and Principle 5 (per-dataset state) compose** as "typed state, typed scope." The tracker owns chunk/proxy state with explicit lifecycle hooks; the per-dataset Maps give every collaborator the right shape for multi-dataset workloads. Together they leave no room for the silent-collapse and dead-state bugs the refactor surfaced.

- **Principle 6 (bounded feedback) is a constraint on Principles 1–5**: the worker's right to report back doesn't create a reactive feedback loop. Eviction reports update tracker state; the next tick's natural drain handles what comes after. The principle exists to prohibit the "reaction that triggers a reaction" anti-pattern that would compromise every other principle's bounded behavior.

When a proposed change cannot honor all principles simultaneously, surface it as an ADR that names the principle being relaxed, the alternatives considered, and the reason for the trade-off.
