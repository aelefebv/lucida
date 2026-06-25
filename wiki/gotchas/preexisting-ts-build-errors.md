---
type: Gotcha
title: "Pre-existing TS Build Errors (resolved)"
description: "pnpm run build in lucida-web/ exits 0."
tags: [lucida, gotcha]
source_path: wiki/gotchas/preexisting-ts-build-errors.md
created: 2026-04-18
modified: 2026-06-25
---

# Pre-existing TS Build Errors (resolved)

## Current state

`pnpm run build` in `lucida-web/` exits 0. `tsc -b` (and `tsc --noEmit -p tsconfig.app.json`) is clean. The three issues described below were resolved as a prerequisite for the deployment Dockerfile build (see [Single-Image Container with `ServeDir` is the Canonical Deploy Unit](../decisions/0020-single-image-with-servedir.md)). Treat this article as a historical record — there is no live footgun to work around.

The bulk of the cleanup landed in commit `593eb8d` ("chore: clear 27 pre-existing TypeScript errors in lucida-web", closing issues #438-#443) on April 20, 2026.

## Historical note

Earlier in the project, three TS errors were known to surface from `npm run build` and were considered "to fix when convenient":

- `lucida-web/src/renderer/renderClient.ts` — `SharedArrayBuffer` type incompatibility. The browser environment lacks COOP/COEP headers in the dev configuration, and TS5.4+ widened typed-array `.buffer` to `ArrayBufferLike` (i.e. `ArrayBuffer | SharedArrayBuffer`), which broke the worker `postMessage` and WebGPU upload sites that wanted a plain `ArrayBuffer`.
- `lucida-web/src/renderLoop.ts` — an unused-import that the strict TS config promoted to error. The import had bounced through several attempted fixes; each time, the import got used elsewhere and the fix became wrong.
- The LZ4 decompression worker (which lives at `lucida-web/src/pipeline/fetch/decode.worker.ts`, formerly described in earlier notes as `lz4.worker.ts`) — `postMessage` overload mismatch. The right answer depended on whether the worker ran in a window context, a web worker, or a service worker — and on whether the buffer being transferred was `ArrayBuffer` vs `ArrayBufferLike`.

The fix pattern (see commit `593eb8d`):

- The `SharedArrayBuffer` widening was narrowed at the WebGPU/postMessage boundaries with `as ArrayBuffer` / `as Uint8Array<ArrayBuffer>` casts (7 sites). This is sound because Lucida does not enable cross-origin isolation, so `SharedArrayBuffer` is never the runtime type — the cast asserts what the runtime guarantees.
- Unused declarations were either deleted (10 cases) or, where deletion would have changed a public signature, the parameter was prefixed with `_`.
- The decode worker's transfer boundary picked up the same `ArrayBuffer` cast, which selected the correct `postMessage` overload.

## What this means now

- `pnpm run build` is the right command and it just works.
- `tsc --noEmit -p tsconfig.app.json` remains the right narrow check during development; see [TS Type-Check Trap](ts-typecheck-trap.md) for why plain `tsc --noEmit` is a no-op in this repo.
- If a similar `SharedArrayBuffer` widening error reappears in the future (e.g. after a TypeScript or `@webgpu/types` bump), the established pattern is the narrowing cast at the boundary, with a comment referencing the original issue (#438) so the next reader knows cross-origin isolation isn't supported.

## Related

- [TS Type-Check Trap](ts-typecheck-trap.md) — companion gotcha about `tsc --noEmit` being a no-op without `-p`
- [lucida-web](../systems/crates/lucida-web.md) — the crate these files live in
- [Single-Image Container with `ServeDir` is the Canonical Deploy Unit](../decisions/0020-single-image-with-servedir.md) — the deployment ADR that depends on a clean `pnpm run build`
- `lucida-web/package.json` build scripts
