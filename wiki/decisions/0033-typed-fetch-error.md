---
type: Decision
title: "Typed `FetchError` + injectable `RetryPolicy` at the fetch boundary"
description: "ContentSource implementations now raise FetchError(kind: \"permanent\" | \"transient\" | \"abort\") at every rejection site, and CpuCache.fetchAndDecode's catch block dispatches via classifyFetchError + an injected RetryPol…"
tags: [lucida, decision]
source_path: wiki/decisions/0033-typed-fetch-error.md
created: 2026-05-15
modified: 2026-05-15
---

# Typed `FetchError` + injectable `RetryPolicy` at the fetch boundary

`ContentSource` implementations now raise `FetchError(kind: "permanent" | "transient" | "abort")` at every rejection site, and `CpuCache.fetchAndDecode`'s catch block dispatches via `classifyFetchError` + an injected `RetryPolicy` (`OnceTransientRetry` for chunks, `NeverRetry` for proxies). Pre-Slice-8 the catch block classified by string-matching `err.message.includes("404") || err.message.includes("malformed")`; the "no wire format registered for image X" rejection matched neither and was wasted on a retry. The source knows what kind of error it raised; the classification belongs there, not in the consumer's catch block.

## Why this shape

Three alternatives considered:

1. **Keep string matching, widen the substrings.** Rejected — every new permanent error (registration miss, dataset gone, bad asset id) would need a coordinated edit on both ends and one round of inevitable bugs. The match was already drift-prone (dechaos pass 5 surfaced it).
2. **Error-code enum on a single `FetchError` base, no `kind` discriminator.** Rejected — the cache really does want to dispatch on a small closed set (retry / fail / silent-cleanup). A flat code enum would force every consumer to maintain its own code-to-bucket mapping.
3. **Separate error classes per kind (`PermanentFetchError`, `TransientFetchError`, `AbortedFetchError`).** Rejected for now — the `kind` discriminator buys the same exhaustiveness without three `instanceof` chains and three sets of constructors. If a future failure mode needs subtype-specific fields (e.g. `RetryAfterFetchError` with a server-suggested delay), promote that one kind to its own subclass without rewriting the others.

`RetryPolicy` is an injectable interface because the chunk and proxy paths already have different retry semantics today (`OnceTransientRetry` vs. `NeverRetry`) and the rule is small enough to be its own unit-test target without dragging in a `CpuCache` integration setup.

## Why backwards-compat substring rules still live in `classifyFetchError`

`classifyFetchError` falls back to the legacy substring rules for plain `Error` throws and logs a `cache.untyped_fetch_error` warning. This keeps the contract one-sided: typed throws are the migration target; untyped throws still work but surface themselves. Slice 8 ports every site in `ProxiedContentSource`; future implementations of `ContentSource` (Direct, Local — deferred Slice 13) inherit the typed contract.

## How this decision shows up in code

- `lucida-web/src/pipeline/fetch/retry.ts` — `FetchError`, `FetchErrorKind`, `classifyFetchError`, `RetryPolicy`, `OnceTransientRetry`, `NeverRetry`.
- `lucida-web/src/pipeline/fetch/contentSource.ts` — every rejection site in `fetch` / `fetchProxy` / `rejectDataset` / `rejectAll` raises a typed `FetchError`.
- `lucida-web/src/pipeline/fetch/cpuCache.ts` — `chunkRetryPolicy` + `proxyRetryPolicy` fields; `fetchAndDecode` + `fetchProxy` catch blocks dispatch via `classifyFetchError`.
- `lucida-web/src/pipeline/fetch/retry.test.ts` — per-kind + per-policy unit tests.
- `lucida-web/src/pipeline/fetch/contentSource.test.ts` — typed-FetchError assertion on the unregistered-image path.

## Related

- [`cpuCache.ts` split into `pipeline/fetch/` modules](0032-cpucache-split-into-pipeline-fetch.md) — parent split this slice lives inside
- [ContentSource (JS) vs FetchSource (wire)](0006-content-source-vs-fetch-source.md) — earlier source contract that this slice extends with typed errors
- PRD #592, issue #602 — the slice that landed this
- `wiki/outputs/dechaos-fetch-decode-2026-05-15/05-contract-scan.md` — the dechaos pass that surfaced the misclassification
