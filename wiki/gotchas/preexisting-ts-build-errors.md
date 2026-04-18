---
created: 2026-04-18
modified: 2026-04-18
---

# Pre-existing TS Build Errors

## The footgun

`npm run build` in `lucida-web/` reports several TypeScript errors that **are not caused by your changes**. Hunting them down when you're trying to land an unrelated PR wastes hours.

Known pre-existing issues:

- `renderClient.ts` — `SharedArrayBuffer` type incompatibility (browser environment lacks COOP/COEP headers in some configurations)
- `renderLoop.ts` — unused import warning that the strict config promotes to error
- `lz4.worker.ts` — `postMessage` overload mismatch

These are well-known in project memory and live in the "to fix when convenient" pile.

## What to do

1. **Don't fix them when you're working on something unrelated.** Leave them alone. Verify that *your* changes don't introduce new errors by diffing the build output before and after your change.
2. **If you genuinely have time** to fix one, treat it as its own focused PR — these errors have history and the fix may require touching the build config or the runtime environment, not just the source.
3. **Use `tsc --noEmit -p tsconfig.app.json`** (see [[ts-typecheck-trap]]) for narrower checks during development; that path skips some of the worker-config-only issues.

## Why they persist

- The `SharedArrayBuffer` issue is environmental — the dev server doesn't set the COOP/COEP headers. Setting them breaks other things (third-party iframes, some debug tooling). The team's been waiting for a clean migration story.
- The unused-import warning has bounced through several attempted fixes; each time, the import gets used elsewhere and the fix becomes wrong.
- The `lz4.worker.ts` overload issue requires picking which `postMessage` signature to honor — and the right answer depends on whether the worker runs in a window context, a web worker, or a service worker.

## Related

- [[ts-typecheck-trap]] — the related "what to actually run" gotcha
- `lucida-web/package.json` build scripts
