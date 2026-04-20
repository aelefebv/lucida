---
created: 2026-04-18
modified: 2026-04-19
---

# AGENT.md — Lucida Repo Wiki

This is a **code-repo wiki** capturing the *why and how it hangs together* layer of the Lucida codebase. The code itself is ground truth for *what* the system does — read it directly when you need exact behavior. This wiki earns its keep by capturing **intent, connective tissue, gotchas, invariants, and in-flight state** that aren't visible from the source alone.

This wiki supersedes the repo's earlier root-level docs for navigational purposes. Of the originals, only `CHUNK_PIPELINE.md` still lives at the repo root as an authoritative narrative document; `ARCHITECTURE.md`, `GLOSSARY.md`, and `DOMAINS.md` no longer exist (referenced by `CLAUDE.md` but missing — see [[queue]]). New connective tissue should land in this wiki.

## Navigation order

When you start a task, read in this order:

1. **`AGENT.md`** (this file) — navigation guide
2. **`now.md`** — current snapshot: active refactors, in-flight work, recent shifts
3. **`index.md`** — root entry point with links to every category
4. **Relevant category indexes** — `systems/index.md`, `decisions/index.md`, `flows/index.md`, `gotchas/index.md`
5. **Specific articles** — drill in via category index or follow `[[wiki-link]]` cross-references

## Wiki-link conventions

This wiki uses Obsidian-style cross-references:

- `[[page]]` — link to an article by filename (without `.md`)
- `[[path/page|Display Text]]` — link with custom display text or full path
- Resolution: glob the wiki for the filename; ambiguous matches require the path form

## Frontmatter conventions

Every article has YAML frontmatter:

```yaml
---
created: YYYY-MM-DD      # set on first creation; never edit by hand
modified: YYYY-MM-DD     # updated whenever the article is edited
---
```

Skills auto-stamp `modified:` on edit. `lint` cross-checks against git timestamps and flags drift.

## Categories

The seeded categories are:

- **`systems/`** — major modules, services, or subsystems. One article per system. Lucida candidates: `lucida-core`, `lucida-server`, `lucida-web`, `lucida-store`, `lucida-protocol`, `lucida-content`, `lucida-cli`, `lucida-proxy`, `lucida-py`, plus subsystems like the chunk pipeline, planning domain, GPU residency.
- **`decisions/`** — ADR-style entries: a choice made, the alternatives, the reason. Especially valuable for non-obvious calls (epoch model, atlas pools, "won't implement" decisions).
- **`flows/`** — end-to-end traces. How a chunk gets from disk → CPU cache → GPU atlas → shader sample. How a presence message propagates. How a follow chain resolves.
- **`gotchas/`** — tribal knowledge, footguns, "we tried X, it broke Y." Examples: TS type-check gotcha (`tsc --noEmit -p tsconfig.app.json`), `npm run build` pre-existing TS errors, Rust 2024 edition binding mode quirks.

Categories are extensible — add new ones organically as the wiki grows.

## Special directories

- **`inputs/`** — read-only source material (RFCs, design docs, PR descriptions, meeting notes, exported tickets). Skills compile from this directory but **never modify files inside it**. Drop reference material here; `repo-wiki-compile` will fold it into articles.
- **`outputs/`** — standalone artifacts produced during conversations: migration plans, refactor proposals, decision drafts that aren't yet promoted to articles. These don't have to satisfy article guardrails — they're working documents.

## Article guardrails

When writing or editing articles, follow these rules. `repo-wiki-lint` enforces them:

**Hard rules**
- No code blocks longer than 3 lines. If you need more, link to the file (module path preferred, file:line allowed sparingly).
- Every article must include at least one of: **why** (rationale, history, alternatives), **interactions** (how this connects to other systems), **gotchas** (footguns, surprises), **invariants** (rules the code enforces but doesn't make obvious).

**Soft guidelines**
- Aim for ≤ 200 lines of prose per article. Hitting the cap suggests the article should be split.
- Prefer durable claims ("the planning domain owns wanted-set computation") over implementation details that rot ("uses BTreeMap with key X" — that belongs in code).
- No function-by-function recap. Articles describe *systems*, not signatures.

**Suppression**
- A `<!-- stale-ok -->` HTML comment in an article suppresses drift warnings from `lint`. Use sparingly for foundational articles whose content is genuinely stable.

## Drift detection

Drift is the central problem of code wikis — code changes constantly, articles don't. The suite addresses it via:

- `repo-wiki-lint` — flags articles whose `modified:` predates significant changes to referenced code, broken file references, missing symbols
- `repo-wiki-update` — explicit user-triggered review after features ship; identifies affected articles and folds in new info
- Always cross-check claims against the current code before acting on them

If a recalled wiki claim conflicts with what you observe in the code, **trust the code** and either update the article or flag the drift.

## Cross-checking with project memory

Austin's auto-memory system (`~/.claude/projects/-Users-austin-GitHub-lucida/memory/`) holds session-scoped facts and project state. Memory entries about Lucida often link back to wiki articles — when you see a memory pointing to a wiki page, treat the wiki as the authoritative narrative and memory as the pointer/index.
