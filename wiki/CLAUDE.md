---
created: 2026-04-18
modified: 2026-05-07
---

# CLAUDE.md — Lucida Repo Wiki

This is a **code-repo wiki** capturing the *why and how it hangs together* layer of the Lucida codebase. The code itself is ground truth for *what* the system does — read it directly when you need exact behavior. This wiki earns its keep by capturing **intent, connective tissue, gotchas, invariants, and in-flight state** that aren't visible from the source alone.

The wiki supersedes the repo's earlier root-level docs for navigational purposes. Of the originals, only `CHUNK_PIPELINE.md` still lives at the repo root as an authoritative narrative document; `ARCHITECTURE.md`, `GLOSSARY.md`, and `DOMAINS.md` no longer exist. New connective tissue lands in this wiki.

## Navigation order

When you start a task, read in this order:

1. **`CLAUDE.md`** (this file) — navigation guide
2. **`now.md`** — current snapshot: active refactors, in-flight work, recent shifts
3. **`index.md`** — root entry point with links to every category
4. **Specific articles** — drill in via the relevant category index or follow `[[wiki-link]]` cross-references

## Wiki-link conventions

Cross-references use Obsidian-style links:

- `[[page]]` — link to an article by basename (no `.md` suffix)
- `[[path/page]]` — path-qualified, **required** when two articles share a basename across the wiki (e.g. `[[render/passes]]` vs `[[audio/passes]]`)
- `[[path/page|Display Text]]` — link with custom display text

When you see a basename collision (lint will flag it), prefer renaming one article over leaving ambiguous links scattered through the wiki.

## Frontmatter conventions

Every article has YAML frontmatter:

```yaml
---
created: YYYY-MM-DD      # set on first creation; never edit by hand
modified: YYYY-MM-DD     # bumped on every edit
---
```

Skills auto-stamp `modified:` on edit. The lint pass cross-checks against git timestamps and flags drift.

## Categories

- **`systems/`** — major modules and runtime-architecture concepts. Split into two sub-folders: `crates/` (one article per Cargo workspace member: `lucida-core`, `lucida-server`, `lucida-web`, `lucida-store`, `lucida-protocol`, `lucida-content`, `lucida-cli`, `lucida-proxy`, `lucida-py`) and `subsystems/` (web-internal modules and cross-cutting runtime concepts: chunk pipeline, planning domain, GPU residency, CPU cache, worker protocol, scene state and epochs, presence and follow, layout system, multichannel and colormaps). Wiki-link resolution is by basename, so `[[lucida-core]]` and `[[chunk-pipeline]]` work unqualified.
- **`decisions/`** — ADR-style records. Files are sequentially numbered (`0001-slug.md`, `0002-slug.md`, …). Each ADR records *that* a decision was made and *why*; optional `Status` / `Considered Options` / `Consequences` sections appear only when they add genuine value. Especially valuable for non-obvious calls (epoch model, atlas pools, "won't implement" decisions).
- **`flows/`** — end-to-end traces. How a chunk gets from disk → CPU cache → GPU atlas → shader sample. How a presence message propagates. How a follow chain resolves.
- **`gotchas/`** — tribal knowledge, footguns, "we tried X, it broke Y." Examples: TS type-check gotcha (`tsc --noEmit -p tsconfig.app.json`), `npm run build` pre-existing TS errors, Rust 2024 edition binding mode quirks.

Categories are extensible — add new ones organically as the wiki grows.

`topics/` is a separate, additive layer: curated cross-cut pages that aggregate articles by architectural concern (e.g. rendering, storage). Topic pages don't own content — they link to articles in their canonical category home. Add a topic page when scanning the four content-type indexes for a single concern becomes tedious.

## Special directories

- **`inputs/`** — read-only source material (RFCs, design docs, PR descriptions, meeting notes, exported tickets). The compile pass reads from this directory but **never modifies files inside it**. Drop reference material here and ask `/repo-wiki` to fold it in.
- **`outputs/`** — standalone artifacts produced during conversations: migration plans, refactor proposals, decision drafts that aren't yet promoted to articles. These don't have to satisfy article guardrails — they're working documents.

## Article guardrails

When writing or editing articles, the lint pass enforces these:

**Hard rules**
- No code blocks longer than 3 lines. If you need more, link to the file (module path preferred, `file:line` allowed sparingly).
- Every article must include at least one of: **why** (rationale, history, alternatives), **interactions** (how this connects to other systems), **gotchas** (footguns, surprises), **invariants** (rules the code enforces but doesn't make obvious).

**Soft guidelines**
- Aim for ≤ 200 lines of prose per article. Hitting the cap suggests the article should be split or promoted.
- Prefer durable claims ("the planning domain owns wanted-set computation") over implementation details that rot ("uses BTreeMap with key X" — that belongs in code).
- No function-by-function recap. Articles describe *systems*, not signatures.

**Suppression**
- A `<!-- stale-ok -->` HTML comment in an article suppresses drift warnings from the lint pass. Use sparingly for foundational articles whose content is genuinely stable.

## Drift detection

Drift is the central problem of code wikis — code changes constantly, articles don't. The `/repo-wiki` skill suite addresses it via:

- **Lint pass** — flags articles whose `modified:` predates significant changes to referenced code, broken file references, missing symbols.
- **Update pass** — explicit user-triggered review after features ship; identifies affected articles and folds in new info.
- **Always cross-check claims against the current code before acting on them.**

If a recalled wiki claim conflicts with what you observe in the code, **trust the code** and either update the article or flag the drift.

## Cross-checking with project memory

Austin's auto-memory system (`~/.claude/projects/-Users-austin-code-lucida/memory/`) holds session-scoped facts and project state. Memory entries about Lucida often link back to wiki articles — when you see a memory pointing to a wiki page, treat the wiki as the authoritative narrative and memory as the pointer/index.
