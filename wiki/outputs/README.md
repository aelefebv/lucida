---
created: 2026-04-18
modified: 2026-05-07
---

# outputs/ — Standalone Artifacts

This directory holds standalone documents produced during conversations: migration plans, refactor proposals, decision drafts, post-mortem write-ups. These don't have to satisfy the article guardrails (no 3-line code limit, no required content types) — they're working documents.

## When something goes here vs into an article

- **Article** (`systems/`, `decisions/`, `flows/`, `gotchas/`) — durable, navigable, follows guardrails. Read by future agents and contributors.
- **`outputs/`** — in-flight or one-shot. A migration plan that will be executed once and then archived. A proposal awaiting review. A decision draft being iterated on before it becomes a `decisions/` article.

When an `outputs/` document stabilizes and represents durable knowledge, promote it to an article in the appropriate category and remove or archive the `outputs/` copy.

## Conventions

- Filename should include the date for time-bound artifacts (e.g., `2026-04-18-gpu-eviction-proposal.md`).
- Standalone artifacts can use frontmatter but it's not required.
