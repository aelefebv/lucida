---
type: Gotcha
title: "React Strict-Mode Kills One-Shot `destroy()` Classes"
description: "A class instance with a destroyed = true flag set in destroy() and never reset gets permanently disabled in dev when its lifecycle is wired to a useEffect cleanup — Strict-Mode double-invokes mount effects (mount → un…"
tags: [lucida, gotcha]
source_path: wiki/gotchas/strict-mode-destroyable-classes.md
created: 2026-05-09
modified: 2026-07-04
---

# React Strict-Mode Kills One-Shot `destroy()` Classes

## The footgun

A class instance with a `destroyed = true` flag set in `destroy()` and never reset gets permanently disabled in dev when its lifecycle is wired to a `useEffect` cleanup — Strict-Mode double-invokes mount effects (mount → unmount → mount), and after the unmount sets `destroyed = true`, the second mount calls `start()` again but the flag stays.

The app is on React 19 (`lucida-web/package.json`); the Strict-Mode mount→unmount→mount double-invoke still applies in React 19, so this footgun is current, not a React-18-only artifact. (The source comment at `urlSync.ts` still says "React 18" — dated wording, same behavior.)

`UrlSync` was the casualty: bug-1's "URL doesn't update on viewport changes" turned out NOT to be the wrapping fix the agent did first — it was that `notifyChange()` and `flush()` both early-returned on `destroyed`, so in dev they silently no-op'd forever after the Strict-Mode unmount. Vitest didn't reproduce (no `<StrictMode>` wrapper), and production builds don't double-invoke, so CI was green and prod-preview was green. Only `npm run dev` in the actual app surfaced it.

## How to detect it

Add a `console.log({ destroyed: this.destroyed })` at the top of any "early-return on destroyed" method in dev. If you see `destroyed: true` while the component is still on screen, that's it. Better: instrument the start/destroy lifecycle and watch for paired calls.

The unit-test gap is real: `@testing-library/react`'s `render` does NOT wrap in `<StrictMode>` by default. To repro Strict-Mode behavior in a test, render `<StrictMode><Component /></StrictMode>` explicitly.

## Two resolutions

Both patterns below are live in the codebase. The invariant either must protect: after Strict-Mode's mount → unmount → mount, whatever instance the second mount uses is fully functional.

### Re-arm on `start()` — for stable-identity singletons

`start()` resets the destroyed flag (`this.destroyed = false`) AND short-circuits if already started (early-return when the listener handle is non-null). `destroy()` stays non-idempotent if you want destroyed to be observable; the contract becomes "destroyable then re-armable" rather than "one-shot." See `lucida-web/src/savedView/urlSync.ts::start()` for the canonical implementation.

Use this when a single instance with stable identity (held in `useState`/`useRef`, surviving across effect runs) is meant to be started and stopped repeatedly, and starting is cheap.

### Fresh instance per effect mount — for per-session stacks

`destroy()` stays genuinely one-shot; instead, the mount effect *constructs* the instance and the cleanup destroys it and clears the ref, so the Strict-Mode remount builds a brand-new stack rather than restarting a dead one. "Constructed ⇒ live, destroyed ⇒ dead forever" stays a true invariant. This is how the session/connection stack works:

- `lucida-web/src/hooks/useBridge.ts` — the wasm-ready effect constructs a `SessionController` (`src/sessionController.ts`, which itself builds the DecodePool/ContentSource/CpuCache/Bridge/Session stack); its cleanup calls `controller.destroy()` (idempotent — tears down the stack and clears the per-connection dataset registry), nulls `controllerRef`/`sessionRef`, and resets connection-scoped React state, so the remount's `controllerRef.current` guard passes and the effect builds a brand-new controller against a fresh WebSocket.
- `lucida-web/src/hooks/useRenderClient.ts` — each effect run constructs a `RenderClient`; the cleanup destroys it and bumps `canvasKey`. The extra wrinkle: `transferControlToOffscreen` (inside the `RenderClient` constructor) is one-shot per `<canvas>` *element*, so a fresh client also needs a fresh element. `App.tsx` keys the canvas element on `canvasKey`, and a `WeakSet` of spent elements stops the re-run from touching an already-transferred canvas before the keyed replacement commits.

Use this when the class wraps a resource that is itself one-shot (a WebSocket connection stack, a transferred canvas, a worker pool) — "re-arming" such an object would amount to reconnecting/reallocating inside it anyway, and reconstruction keeps the object's lifecycle honest.

### Choosing between them

- Stable identity, cheap start/stop, other code holds long-lived references to the instance → **re-arm**.
- Per-mount lifecycle, expensive or inherently one-shot underlying resource, nothing outside the effect keeps the instance past cleanup → **instance per mount**.

## Where this could bite again

The dangerous shape is the *combination*:
- A class instance with **stable identity across effect runs** (constructed in `useState`/`useRef` or module scope)
- A `useEffect(() => { instance.start(); return () => instance.destroy(); }, [instance])`
- A `destroyed` (or `disposed`, `closed`, etc.) boolean checked at method entry, never reset and never bypassed by reconstruction

As of the PR #483 fix, `UrlSync` was the only instance matching all of that. `sessionController.ts`, `bridge.ts`, `session.ts`, and `renderer/renderClient.ts` carry the same one-shot `destroyed`/`destroy()` shape but are safe by the second resolution: each is constructed inside (or by an object constructed inside) the effect whose cleanup destroys it, so no destroyed instance is ever asked to work again. New code in the footgun shape must adopt one of the two resolutions — the failure mode is dev-only and invisible to both vitest and production builds.

## Related

- `lucida-web/src/savedView/urlSync.ts::start()` — the canonical re-arm-after-destroy implementation
- `lucida-web/src/hooks/useBridge.ts` / `lucida-web/src/hooks/useRenderClient.ts` — the canonical instance-per-mount implementations
- [Saved Views](../systems/subsystems/saved-views.md) — the subsystem that tripped over this
- `wiki/gotchas/app-tsx-hook-order.md` — adjacent React-quirk territory
