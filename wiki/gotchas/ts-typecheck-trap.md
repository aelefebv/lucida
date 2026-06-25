---
type: Gotcha
title: "TS Type-Check Trap"
description: "Running npx tsc --noEmit from lucida-web/ looks like it works — exits successfully, prints nothing."
tags: [lucida, gotcha]
source_path: wiki/gotchas/ts-typecheck-trap.md
created: 2026-04-18
modified: 2026-06-25
---

# TS Type-Check Trap

## The footgun

Running `npx tsc --noEmit` from `lucida-web/` looks like it works — exits successfully, prints nothing. But it's **a no-op in this repo**: the default `tsconfig.json` exists only as a project references container; the actual app sources are configured in `tsconfig.app.json` and aren't included by the default invocation.

The first time you discover this is usually after committing code that fails TypeScript with `pnpm run build`.

## What to run instead

```
tsc --noEmit -p tsconfig.app.json
```

Or, to check the whole project graph including referenced configs:

```
tsc -b --dry
```

## Why this happens

The repo uses **TypeScript project references** to keep the build-tool config and the app config independent. The root `tsconfig.json` is a container with `references` but no own `files`/`include`. `tsc` invoked without `-p` picks up the container, sees no input files, and immediately exits clean.

(The app's actual Web Workers, e.g. `pipeline/fetch/decode.worker.ts`, live under `src/` and are covered by `tsconfig.app.json` — they are not a separate project.)

This is documented behavior; it's just unintuitive when you're used to `tsc --noEmit` "doing the right thing" in a single-config repo.

## Related

- `lucida-web/tsconfig.json` (the container)
- `lucida-web/tsconfig.app.json` (the actual app config)
- `lucida-web/tsconfig.node.json` (build-tool config — `vite.config.ts` only)
