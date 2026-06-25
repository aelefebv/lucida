---
created: 2026-05-07
modified: 2026-06-25
---

# Topics

Curated cross-cuts that pull together articles by **architectural concern** rather than by content type. Useful when the question is "show me everything about X" and X spans systems, ADRs, flows, and gotchas.

These pages don't own content — they aggregate links to articles that live in their canonical home (`systems/`, `decisions/`, `flows/`, `gotchas/`). Add a topic page when a concern accumulates enough articles that scanning the four content-type indexes becomes tedious.

## Topics

- [[topics/rendering]] — the chunk pipeline cluster: planning → CPU cache → GPU residency → render. Roughly half the wiki by article count.
- [[topics/storage-and-import]] — `lucida-store`, the three-output import model, on-wire envelopes, axes/codec gotchas.
- [[topics/collaboration]] — the document-vs-viewport split, presence, follow chains, server relay.
- [[topics/workspaces]] — the server-stored container: dataset identities, roles, sharing, create-from-dataset, duplicate, never-leak access. The container, not the live session.
- [[topics/auth-and-deployment]] — who-you-are and how-it-ships as one hub: cookie-vs-bearer credentials, bind-address-driven auth mode, the `LUCIDA_*` env contract, OSS-from-day-one.
- [[topics/agent-surfaces]] — the non-browser clients: `lucida` CLI + Python package, headless montage/screenshot/overview, and the shared parity + structured-error model.
- [[topics/build-and-tooling]] — TS / WASM / Rust build footguns. Distinct from runtime gotchas.
