# Topics

Curated cross-cuts that pull together articles by **architectural concern** rather than by content type. Useful when the question is "show me everything about X" and X spans systems, ADRs, flows, and gotchas.

These pages don't own content — they aggregate links to articles that live in their canonical home (`systems/`, `decisions/`, `flows/`, `gotchas/`). Add a topic page when a concern accumulates enough articles that scanning the four content-type indexes becomes tedious.

## Topics

- [Topic: Rendering](rendering.md) — the chunk pipeline cluster: planning → CPU cache → GPU residency → render. Roughly half the wiki by article count.
- [Topic: Storage and Import](storage-and-import.md) — `lucida-store`, the three-output import model, on-wire envelopes, axes/codec gotchas.
- [Topic: Collaboration](collaboration.md) — the document-vs-viewport split, presence, follow chains, server relay.
- [Topic: Workspaces](workspaces.md) — the server-stored container: dataset identities, roles, sharing, create-from-dataset, duplicate, never-leak access. The container, not the live session.
- [Topic: Auth and Deployment](auth-and-deployment.md) — who-you-are and how-it-ships as one hub: cookie-vs-bearer credentials, bind-address-driven auth mode, the `LUCIDA_*` env contract, OSS-from-day-one.
- [Topic: Agent Surfaces](agent-surfaces.md) — the non-browser clients: `lucida` CLI + Python package, headless montage/screenshot/overview, and the shared parity + structured-error model.
- [Topic: Build and Tooling](build-and-tooling.md) — TS / WASM / Rust build footguns. Distinct from runtime gotchas.
