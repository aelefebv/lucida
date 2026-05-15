---
created: 2026-05-14
modified: 2026-05-14
---

# Deferred — considered but not built yet

Things we explored, decided not to ship today, and want to remember
for later. Each entry sketches the idea inline and links to the ADR
that establishes the relevant context.

## Multi-LOD atlas residency

Today, each entity holds chunks at exactly one LOD level in the GPU
atlas at a time. When the user zooms past a threshold, the entity's
old-LOD chunks evict, the new-LOD chunks fetch and upload fresh, and
the [[principles/planning|proxy fallback chain]] bridges the visible
gap while detail loads.

**Sketch.** Allow each entity to hold chunks at multiple LOD levels
simultaneously — e.g., target LOD plus one or two coarser ones. When
the user zooms, the next LOD is already resident; the transition is
instant rather than fetch-bound. Planning would re-introduce a buffer
config (`coarsestDetailLod = min(targetLod + lodBuffer, maxLevel)`)
so requests for buffer LODs flow through. The CPU cache already
handles multi-LOD chunks per entity. The GPU atlas needs the
allocator changes — variable per-entity slot reservations, eviction
policy that reasons across LODs within an entity (when memory is
tight, prefer evicting an entity's coarser LODs first), and possibly
per-LOD pool sizing.

**Cost.** Most of the work is in the atlas allocator and eviction
policy on the GPU worker side. Planning's contribution is small
(restore the buffer config + thread it through `makeFieldEntry`).
Test coverage on the atlas would need to grow to exercise multi-LOD
scenarios. Memory budgets per atlas would likely need to grow to
absorb the extra residency.

**Why deferred.** No current UX evidence that zoom transitions feel
jarring — the proxy fallback chain bridges the gap acceptably for
the workloads we test against. The single-LOD model is naturally
bounded ([[principles/planning#2-memory-is-the-binding-constraint]]);
multi-LOD requires explicit memory policy that we don't have a need
to design yet. Reconsider if sustained user feedback says zoom
snappiness matters more than the current trade, or if a perf budget
makes idle atlas slots cheaper than they are today.

## Per-browser anonymous identity in disabled-auth mode

Today, [[decisions/0018-auth-mode-auto-detect-by-bind-address|disabled-auth mode]]
gives every request the same `dev@local` principal — fine for solo
local use, but multi-user scenarios (someone exposes their port to
share with friends on a LAN) end up with one shared bookmark
namespace, every action attributed to `dev@local`, and admin endpoints
unprotected.

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
the disabled-mode extractor (replacing today's stateless stub), and a
display-name strategy ("Anon" + last 4 of uuid? a "Set your name"
prompt on first visit?).

**Why deferred.** PRD #527 prioritized restoring the documented
shared-`dev@local` semantics first — it's the simpler model, fewer
moving parts, and matches what ADR-0018 and the auth subsystem article
already say. The per-browser model is a refinement to revisit if
demand for "multi-user without OAuth" surfaces.
