---
created: 2026-04-18
modified: 2026-04-18
---

# Now — Lucida Current State

Snapshot of what's active in the Lucida codebase. Refresh with `/repo-wiki-now` after significant shifts.

## Wiki status

Bootstrapped 2026-04-18 via `/repo-wiki-init` followed by `/repo-wiki-derive` across the whole repo. The wiki now has:

- 9 crate/package articles in [[systems/index|Systems]]
- 9 web subsystem articles in [[systems/index|Systems]]
- 11 [[decisions/index|Decisions]] derived from code analysis (rationale is inferred — enrich via `/repo-wiki-update` or `/repo-wiki-interview` when you have authoritative context)
- 6 end-to-end [[flows/index|Flows]]
- 12 [[gotchas/index|Gotchas]]

Source-of-truth narrative docs at the repo root remain authoritative until folded into the wiki:

- `CHUNK_PIPELINE.md` — long-form chunk lifecycle trace; [[chunk-pipeline]] cites it
- `CLAUDE.md` — agent entry point (currently points at `ARCHITECTURE.md` and `DOMAINS.md` which don't exist; cross-reference may be stale)

Project memory at `~/.claude/projects/-Users-austin-GitHub-lucida/memory/MEMORY.md` carries pointers to recent project-state docs.

## Recent shifts (from git log, as of 2026-04-18)

- `1718e9a` — wire envelope shape clarified; `ContentSource` (JS) vs `FetchSource` (wire) split documented in `CHUNK_PIPELINE.md`. See [[decisions/content-source-vs-fetch-source]].
- `c1d982d` — rename: `ContentGraph → DatasetManifest`, `ClientFetchDescriptor → FetchSource`, `register_dataset → dataset_opened`. See [[decisions/three-output-import-model]].
- `9908f8b` — removed unused docs and code
- `4aec276` — DOMAINS step 9: unified semantic fallback chain in slice/volume shaders. Documented in [[gpu-residency#semantic-fallback-chain]].
- `b0a5985` — perf: hoist `EntityDescriptor` read out of volume ray-march loop. Mentioned in [[gpu-residency]].

## In-flight (per project memory)

- **Chunk pipeline structural cleanup** — upload loop unified (#253). Remaining: resolve GPU state duplication (do after progressive LOD fixes).
- **lucida-store redesign** — PRD #148, storage abstraction layer with server-side chunk serving.

## Next wiki actions to consider

- Drop PRDs (#378 worker protocol, #383 GPU residency, #393 shared atlas pools, #397 proxies, #148 store redesign) into `wiki/inputs/` and run `/repo-wiki-compile` to enrich the derived decision articles with authoritative rationale.
- Run `/repo-wiki-interview` to capture any tribal knowledge that's not visible in the code (e.g., why specific threshold constants in [[planning-domain]] are tuned the way they are).
- After significant code shifts, run `/repo-wiki-update` to refresh affected articles.
