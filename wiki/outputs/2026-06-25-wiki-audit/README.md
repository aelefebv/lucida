# Wiki deep audit — 2026-06-25

Working-doc reports from a deep audit of the wiki against the current source (post the 2026-06-25 cleanup, PR #840). Each report cross-checks one wiki area, cites `file:line`/symbol evidence, and is **actionable** — apply the fixes, then this directory can be deleted like any other shipped working doc.

| Report | Scope | Headline |
|---|---|---|
| [decisions.md](decisions.md) | 42 ADRs + deferred | No decision is *wrong* or silently superseded; what rotted is supporting detail — stale code anchors (ADR 0029 `planning/index.ts` split, `orchestrator.ts`→`tickCoordinator.ts`), dead paths, 2 bad LOC estimates, 1 nonexistent function. Section 1 lists each. |
| [gotchas.md](gotchas.md) | 23 gotchas | Most still apply. Materially off: `wasm-rebuild-after-rust-changes` (false premises), `document-vs-viewport-classification` (wrong sync mechanism), `oss-config-defaults` (nonexistent env var), `scene-document-state-json-compat` (test in wrong file), `ts-typecheck-trap` (mislabels `tsconfig.node.json`). |
| [flows.md](flows.md) | 9 flows + proposals | Existing flows mostly hold (per-flow table). Proposes 5 new flows: annotation capture→restore→deep-link (top), CLI/agent headless capture, layout-switch re-anchor, saved-view propose→approve, OAuth JWKS refresh. |
| [principles.md](principles.md) | new principles docs | **Guiding-light** product principles (not mechanics): proposes `surface-parity`, `agent-first-access`, `collaboration-and-reproducibility`, `runs-anywhere-and-open` — each with statements + honest `today:`/`aspirational:` grounding. |
| [systems.md](systems.md) | crates + subsystems | 9 crate articles (5 accurate / 3 drifted / 1 count error); subsystem table. Coverage gaps needing articles: **annotations/mentions/threads** (highest), camera/3D-nav + key-bindings, 3D focal depth, debug panel. |
| [topics.md](topics.md) | 4 topic pages | `build-and-tooling` clean; `collaboration` incomplete (workspaces landed); `rendering` + `storage-and-import` drifted. Suggests new topics: `auth-and-deployment`, `agent-surfaces`, `workspaces`, `diagnostics-and-observability`. |

Method: a background workflow fanned out ~25 opus / medium-effort agents (one set per area), each read-only against source; findings synthesized into the reports above. `principles.md` was re-done to the guiding-light framing (product north-stars, not implementation details).
