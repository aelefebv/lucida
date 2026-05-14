---
created: 2026-05-14
modified: 2026-05-14
---

# Deferred — considered but not built yet

Things we explored, decided not to ship today, and want to remember
for later. Each entry sketches the idea inline and links to the ADR
that establishes the relevant context.

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
