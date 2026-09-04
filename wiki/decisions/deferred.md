---
type: Decision
title: "Deferred — considered but not built yet"
description: "Things we explored, decided not to ship today, and want to remember"
tags: [lucida, decision]
source_path: wiki/decisions/deferred.md
created: 2026-05-14
modified: 2026-09-04
---

# Deferred — considered but not built yet

Things we explored, decided not to ship today, and want to remember
for later. Each entry sketches the idea inline and links to the ADR
that establishes the relevant context.

## Per-browser anonymous identity in disabled-auth mode

Today, [disabled-auth mode](0018-auth-mode-auto-detect-by-bind-address.md)
defaults every browser to the same non-admin `dev@local` principal. On
a loopback bind a developer can intentionally switch a browser to
another local dev identity with `/auth/dev/login`, which is enough for
manual role tests, but Lucida still does not auto-assign distinct
identities to different browsers.

**Sketch.** In disabled mode, when no session cookie is present, the
extractor would auto-mint a session row with `email = anon-{uuid8}@local`
and set the cookie. Subsequent requests from that browser keep that
identity (cookie sticks; real session row in the same SQLite store the
Google path uses). Each browser gets a distinct "user." Bookmarks are
per-browser, audit logs differentiate. Still no actual security —
anyone clearing cookies becomes a new anon user — but it's honest about
being multi-user.

**Cost.** Reuses the existing session store and cookie machinery (no
new persistence path). The new bits are: the auto-mint logic inside
the disabled-mode extractor (replacing today's stateless stub), a
display-name strategy ("Anon" + last 4 of uuid? a "Set your name"
prompt on first visit?), and a sign-out URL for disabled mode, which
has none today because there is nothing to clear (see
[Post-Logout Marker Cookie](0019-post-logout-marker-cookie-and-prompt-select-account.md)).

**Why deferred.** PRD #527 prioritized restoring the documented
shared-`dev@local` semantics first — it's the simpler model, fewer
moving parts, and matches what ADR-0018 and the auth subsystem article
already say. The per-browser model is a refinement to revisit if
demand for "multi-user without OAuth" surfaces.

## One lifetime for the dev-controls surface

The surviving mutation surface after
[ADR 0052](0052-debug-surface-dispositions.md) holds knobs with two different
lifetimes. The planning knobs are backed by `configStore` and persist to
`localStorage`, surviving reload and continuing to steer the planner in
production builds — which is why "Reset all to defaults" stays enabled there.
The four cache knobs inherited from the old Cache tab go through
`CpuCache.updateConfig`, which is an `Object.assign` onto a live instance: no
persistence, gone on reload, and useless without a live session.

**Sketch.** Move `CpuCacheConfig` onto `configStore` so every knob on the
surface persists, resets, and validates the same way, and the UI no longer has
to carry a "session-scoped" label warning that four of its controls behave
differently from the rest.

**Cost.** `configStore` already has the shape — `TunableSpec` entries, per-field
reset, `useSyncExternalStore` wiring, live validators. The work is on the
`CpuCache` side: a persisted budget has to be reconciled with elastic tier
budgets at construction rather than only on `updateConfig`, and a bad persisted
value would then follow a user across sessions into a hot fetch path, so the
bounds need to be enforced in the store rather than trusted from the input.

**Why deferred.** Reworking a hot fetch path's configuration lifetime inside a
debug-surface disposition would expand ADR 0052 well past what it decides. The
lifetime split is honest and visible in the meantime; unifying it is a cleanup
with no user-visible payoff, best done when `CpuCacheConfig` is next opened for
another reason.
