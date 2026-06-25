---
type: Guide
title: "Wiki guide — conventions and navigation"
description: "How the Lucida repo wiki is organized as an Open Knowledge Format (OKF) bundle, and the order to read it in."
tags: [lucida, guide]
source_path: wiki/CLAUDE.md
created: 2026-04-18
modified: 2026-06-25
---

# Wiki guide — conventions and navigation

This is a **code-repo wiki** capturing the *why and how it hangs together* layer of the Lucida codebase. The code itself is ground truth for *what* the system does — read it directly when you need exact behavior. This wiki earns its keep by capturing **intent, connective tissue, gotchas, invariants, and in-flight state** that aren't visible from the source alone.

The wiki is an **[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) (OKF) bundle**: a directory tree of Markdown notes whose root `index.md` declares `okf_version`. The conventions below are what make it a conformant bundle.

## Navigation order

When you start a task, read in this order:

1. **`CLAUDE.md`** (this file) — conventions + navigation guide
2. **`now.md`** — current snapshot: active refactors, in-flight work, recent shifts
3. **`index.md`** — root entry point with links to every category
4. **Specific articles** — drill in via the relevant category `index.md`, then follow the cross-reference links between articles

## Bundle layout

`index.md` is **reserved**: in every directory it is a routing table — an intro plus links to that directory's children — and carries **no frontmatter**. The single exception is the bundle root `wiki/index.md`, whose only frontmatter is `okf_version: "0.1"`.

Every other `.md` file is a **note** and carries YAML frontmatter (below). Directories nest: `systems/index.md` routes to `systems/crates/index.md` and `systems/subsystems/index.md`, each of which routes to its own notes.

## Frontmatter conventions

Every note (every non-`index.md` article) begins with YAML frontmatter. `type` is the only field OKF requires; the rest are conventions this bundle keeps:

```yaml
---
type: Subsystem            # required — the note's kind (see taxonomy below)
title: "GPU Residency"     # the article's H1
description: "One sentence on what this note covers."
tags: [lucida, subsystem]  # always lead with `lucida`, then the category
source_path: wiki/systems/subsystems/gpu-residency.md
created: 2026-04-18         # set on first creation; never edit by hand
modified: 2026-06-25        # bumped on every edit
---
```

`type` values used in this bundle, by directory:

| `type` | Lives in | What it is |
|---|---|---|
| `Decision` | `decisions/` | ADR-style record of a choice and its rationale |
| `Principle` | `principles/` | a guiding-light claim about what a part of the product optimizes for |
| `Crate` | `systems/crates/` | one Cargo workspace member |
| `Subsystem` | `systems/subsystems/` | a web-internal module or cross-cutting runtime concept |
| `Flow` | `flows/` | an end-to-end trace through the system |
| `Gotcha` | `gotchas/` | tribal knowledge, footguns, "we tried X, it broke Y" |
| `Topic` | `topics/` | a curated cross-cut that aggregates articles by concern |
| `Status` | `now.md` | the living current-state snapshot |
| `Queue` | `queue.md` | open questions and things to investigate |
| `Guide` | this file | how to read and maintain the wiki |

Add a new `type` when a genuinely new kind of note appears — keep the value capitalized and add a row here.

## Link conventions

Cross-references are **relative Markdown links to the target's file**, resolved from the linking file's directory:

- `[GPU Residency](gpu-residency.md)` — same directory
- `[lucida-core](../crates/lucida-core.md)` — sibling directory
- `[Canonical dataset URL form](../decisions/0042-...md)` — another category
- `[GPU Residency](gpu-residency.md#semantic-fallback-chain)` — deep-link to a heading

(Those four are illustrative syntax, not live links.)

Filenames are **kebab-case** (`scene-state-and-epochs.md`). Decisions are sequentially numbered (`0001-slug.md`). Because links point at files, two articles may share a stem in different directories without ambiguity.

## Categories

- **`systems/`** — major modules and runtime-architecture concepts, split into `crates/` (one article per Cargo workspace member: `lucida-core`, `lucida-server`, `lucida-web`, `lucida-store`, `lucida-protocol`, `lucida-content`, `lucida-cli`, `lucida-proxy`, `lucida-py`) and `subsystems/` (web-internal modules and cross-cutting concepts: the chunk pipeline, planning, GPU residency, CPU cache, worker protocol, scene state and epochs, presence and follow, layouts, multichannel and colormaps, annotations, camera, auth, deployment).
- **`decisions/`** — ADR-style records, sequentially numbered. Each records *that* a decision was made and *why*; optional `Status` / `Considered Options` / `Consequences` sections appear only when they add value. Especially valuable for non-obvious calls (epoch model, atlas pools, "won't implement" decisions).
- **`principles/`** — guiding-light claims about what each part of the product optimizes for. ADRs cite a principle as justification; principles never cite ADRs back (see `principles/index.md`).
- **`flows/`** — end-to-end traces. How a chunk gets from disk → CPU cache → GPU atlas → shader sample. How a presence message propagates. How a follow chain resolves.
- **`gotchas/`** — tribal knowledge, footguns, build-system quirks.
- **`topics/`** — an additive layer of curated cross-cut pages that aggregate articles by concern (rendering, storage, collaboration, …). Topic pages don't own content — they link to articles in their canonical category home. Add one when scanning the category indexes for a single concern becomes tedious.

Categories are extensible — add new ones organically as the wiki grows.

## Special directories

- **`inputs/`** — read-only source material (RFCs, design docs, PR descriptions, meeting notes). The compile pass reads from here but **never modifies files inside it**. See `inputs/index.md`.
- **`outputs/`** — standalone working artifacts: migration plans, refactor proposals, decision drafts not yet promoted to articles. See `outputs/index.md`.

## Article guardrails

When writing or editing articles:

**Hard rules**
- No code blocks longer than 3 lines. If you need more, link to the file (module path preferred, `file:line` allowed sparingly).
- Every article includes at least one of: **why** (rationale, history, alternatives), **interactions** (how this connects to other systems), **gotchas** (footguns, surprises), **invariants** (rules the code enforces but doesn't make obvious).

**Soft guidelines**
- Aim for ≤ 200 lines of prose per article. Hitting the cap suggests the article should be split or promoted.
- Prefer durable claims ("the planning domain owns wanted-set computation") over implementation details that rot ("uses BTreeMap with key X" — that belongs in code).
- No function-by-function recap. Articles describe *systems*, not signatures.

**Suppression**
- A `<!-- stale-ok -->` HTML comment suppresses drift warnings for a foundational article whose content is genuinely stable. Use sparingly.

## Drift detection

Drift is the central problem of code wikis — code changes constantly, articles don't.

- **Lint pass** — flags articles whose `modified:` predates significant changes to referenced code, broken file references, missing symbols.
- **Update pass** — explicit user-triggered review after features ship; identifies affected articles and folds in new info.
- **Always cross-check claims against the current code before acting on them.** If a recalled wiki claim conflicts with what you observe in the code, **trust the code** and either update the article or flag the drift.

## Cross-checking with project memory

Austin's auto-memory system (`~/.claude/projects/-Users-austin-code-lucida/memory/`) holds session-scoped facts and project state. Memory entries about Lucida often link back to wiki articles — when you see a memory pointing to a wiki page, treat the wiki as the authoritative narrative and memory as the pointer/index.
