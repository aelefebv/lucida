---
type: Gotcha
title: "Vitest Can't Load Browser-Environment Tests From a Checkout Inside `.git`"
description: "Vite's default server.fs.deny includes **/.git/**, so from a checkout under a .git directory every happy-dom test file fails with `Cannot find module '/src/...'` — and the workaround has sharp edges worth knowing."
tags: [lucida, gotcha]
source_path: wiki/gotchas/vitest-checkout-inside-git-dir.md
created: 2026-07-25
modified: 2026-07-25
---

# Vitest Can't Load Browser-Environment Tests From a Checkout Inside `.git`

## The footgun

Run `pnpm test` from a checkout that lives *inside* a `.git` directory — most often a linked
worktree created at `.git/<something>/`, which is what agent tooling tends to do — and a large
block of test files fails before a single assertion runs:

```
FAIL  src/App.wiring.test.tsx [ src/App.wiring.test.tsx ]
Error: Cannot find module '/src/App.wiring.test.tsx'
```

The failing set is exactly the files carrying `// @vitest-environment happy-dom` — 49 of 153 when
this was found. Nothing is wrong with them; from the same commit at an ordinary path they pass.

This one is nasty because the failures look like real breakage and are spread across the suite, so
the cost is either a long wrong-turn diagnosis or — worse — learning to treat red output as noise.

## Why it happens

Vite's `server.fs.deny` defaults to `['.env', '.env.*', '*.{crt,pem}', '**/.git/**']`. The last
entry keeps a server from ever handing repository internals to a client. It quietly assumes the
project is not itself inside a `.git` directory.

When it is, the project's own files match `**/.git/**` too. Test files in a browser-like
environment go through Vite's transform pipeline, which consults `isFileLoadingAllowed` before
reading from disk; the read is refused, no code comes back, and Vitest reports the module as
missing. Node-environment test files don't take that path, which is why only part of the suite
goes red.

## What we do about it

`lucida-web/vite.config.ts` replaces the blanket `**/.git/**` rule with one **anchored at the
checkout root**, when all of these hold:

- `process.env.VITEST` is truthy (Vitest sets it before the config loads), and
- `mode === 'test'`, and
- the config's own directory has a `.git` path segment.

The anchored rule still denies any real `.git` directory *inside* the checkout, which is the part
that matters: `.git/config` routinely carries a remote URL with an embedded token. Without the
anchor a nested `.git` is served in full — measured, with the credential visible in the response
body.

From an ordinary checkout none of this engages, so the config there is unchanged in every mode.

## What is guarded, precisely

In force everywhere, tests included:

- `.env`, `.env.*` and `*.{crt,pem}`.
- `server.fs.strict`.
- Any `.git` directory **inside** the checkout (the anchored rule).

## What is *not* guarded — read this before relying on the above

Five things that are easy to assume and are false.

**The surrounding `.git` directory is not protected by any glob, and cannot be.** The checkout sits
*inside* it, so a pattern denying the parent denies the checkout with it. Reachability is decided
entirely by `server.fs.allow` — and **Vitest unions its own entries into the config's `allow`**
rather than replacing it. `resolveFsAllow` contributes `dirname(configFile)`,
`searchForWorkspaceRoot(root)` and its own dist dir; the config's `allow: ['..']` survives
alongside them, which is why `../lucida-core/pkg` still resolves during tests. A union is never
narrower, so those added entries can only ever widen what a test server can read. Today they all
land inside the checkout, but only because this repo has no workspace marker above it.
`searchForWorkspaceRoot` walks up for `pnpm-workspace.yaml`, `lerna.json`, a `workspaces`
package.json or a workspace `deno.json`; finding none it falls back to the nearest package root,
`lucida-web`. **Adding a `pnpm-workspace.yaml` at the repo root — an ordinary thing to do in a pnpm
repo — adds the repo root to the union and exposes the surrounding `.git` in full.** That was
measured: the outer `.git/config` came back with its credential-bearing remote URL. Because an
unrelated commit could cause that silently, the config now calls `searchForWorkspaceRoot` itself
and **throws a startup error** if the result escapes the checkout, instead of quietly relaxing.

**A test run is not serverless.** `vitest --api` and `vitest --ui` start a real HTTP listener on
localhost serving this same transform pipeline over `/@fs`; that is how the exposure above was
measured. A plain `vitest run` — what `pnpm test` does — opens no listener, and nothing in this
repo passes `--api` today.

**"Dev and preview always keep the full default list" is not unconditionally true.** The switch
keys off the `VITEST` environment variable plus `--mode test`, not off the command, so a dev server
started with both would get the relaxed list. Requiring `mode === 'test'` is what stops a stray
exported `VITEST=1` from silently relaxing `pnpm dev`.

**Every file under the checkout is reachable during a test run, not just source and tests.** A
plain `.js` file dropped at the checkout root is served. The blast radius is the whole checkout
minus the denied patterns above.

**Running Vitest with a non-test `--mode` from such a checkout brings the whole failure back.**
`vitest run --mode development` measured 49 failed / 104 passed here — the original symptom
verbatim, with nothing in the output pointing at this page. That is the price of gating on
`mode === 'test'`, and it is deliberate: the alternative is a stray exported `VITEST=1` silently
relaxing `pnpm dev`. If you see the `Cannot find module '/src/…'` wall again, check the `--mode`
you passed before you go looking at the code.

## Also worth knowing

`pnpm dev` **does not work at all** from a checkout inside `.git`: the relaxation is test-only, so
the dev server still refuses its own source (`/src/main.tsx` → 403, measured). If you need the dev
server, work from an ordinary checkout.

`vite.config.ts` **is not covered by CI's type-check job**, which runs
`tsc --noEmit -p tsconfig.app.json` (see [TS Type-Check Trap](ts-typecheck-trap.md)); the config
belongs to `tsconfig.node.json`. What checks it is the *Build SPA* step, `pnpm run build`
(`tsc -b && vite build`). So the imports and the function-form `defineConfig` here are gated by the
build, not by the job named for type-checking.

## Related

- `lucida-web/vite.config.ts` (the `server.fs` block and its comment)
- [Vite `server.fs.deny`](https://vite.dev/config/server-options.html#server-fs-deny)
- [TS Type-Check Trap](ts-typecheck-trap.md) — the other "this tool looks like it works but doesn't" trap in `lucida-web`
