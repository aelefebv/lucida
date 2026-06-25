---
created: 2026-05-09
modified: 2026-06-25
---

# React Strict-Mode Kills One-Shot `destroy()` Classes

## The footgun

A class instance with a `destroyed = true` flag set in `destroy()` and never reset gets permanently disabled in dev when its lifecycle is wired to a `useEffect` cleanup — Strict-Mode double-invokes mount effects (mount → unmount → mount), and after the unmount sets `destroyed = true`, the second mount calls `start()` again but the flag stays.

The app is on React 19 (`lucida-web/package.json`); the Strict-Mode mount→unmount→mount double-invoke still applies in React 19, so this footgun is current, not a React-18-only artifact. (The source comment at `urlSync.ts` still says "React 18" — dated wording, same behavior.)

`UrlSync` was the casualty: bug-1's "URL doesn't update on viewport changes" turned out NOT to be the wrapping fix the agent did first — it was that `notifyChange()` and `flush()` both early-returned on `destroyed`, so in dev they silently no-op'd forever after the Strict-Mode unmount. Vitest didn't reproduce (no `<StrictMode>` wrapper), and production builds don't double-invoke, so CI was green and prod-preview was green. Only `npm run dev` in the actual app surfaced it.

## How to detect it

Add a `console.log({ destroyed: this.destroyed })` at the top of any "early-return on destroyed" method in dev. If you see `destroyed: true` while the component is still on screen, that's it. Better: instrument the start/destroy lifecycle and watch for paired calls.

The unit-test gap is real: `@testing-library/react`'s `render` does NOT wrap in `<StrictMode>` by default. To repro Strict-Mode behavior in a test, render `<StrictMode><Component /></StrictMode>` explicitly.

## Fix pattern

`start()` must reset the destroyed flag (`this.destroyed = false`) AND short-circuit if already started (early-return when the listener handle is non-null). See `lucida-web/src/savedView/urlSync.ts::start()` for the canonical implementation.

`destroy()` should remain non-idempotent if you want destroyed to be observable, but the contract becomes "destroyable then re-armable" rather than "one-shot."

## Where this could bite again

Anywhere we have:
- A class instance constructed in `useState` or `useRef` with stable identity
- A `useEffect(() => { instance.start(); return () => instance.destroy(); }, [instance])`
- A `destroyed` (or `disposed`, `closed`, etc.) boolean checked at method entry

As of the PR #483 fix, `UrlSync` is the only instance matching *all* of the above — stable-identity instance, `useEffect` start/cleanup, and an entry-guard flag that `destroy()` permanently sets. Other classes carry a partial `destroyed`/`destroy()` shape (`bridge.ts`, `renderer/renderClient.ts`) but don't hit the full footgun. New code in this shape needs the re-arm pattern.

## Related

- `lucida-web/src/savedView/urlSync.ts::start()` — the canonical re-arm-after-destroy implementation
- [[saved-views]] — the subsystem that tripped over this
- `wiki/gotchas/app-tsx-hook-order.md` — adjacent React-quirk territory
