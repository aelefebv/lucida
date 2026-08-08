# Wiki guide — conventions and navigation

This wiki holds **only the durable "why" layer** of the Lucida codebase: architectural
decisions and the principles they appeal to.

**It does not describe current behavior, and it is not kept in sync with the code.**
Descriptive articles (subsystem walkthroughs, end-to-end flows, current-state snapshots,
build gotchas) used to live here and were removed: they rotted faster than anyone
updated them, and agents trusted them over the source. Do not reintroduce that layer.
If you want to know what the system does today, read the code.

## What belongs here

Two kinds of note, and nothing else:

| `type` | Lives in | What it is |
|---|---|---|
| `Decision` | `decisions/` | ADR-style record of a choice and its rationale |
| `Principle` | `principles/` | a guiding-light claim about what a part of the product optimizes for |

ADRs cite principles as justification; principles never cite ADRs back (see
`principles/index.md`).

A note earns its place if it would still be true, and still useful, after the
implementation is rewritten. Anything narrating current structure does not qualify —
that's a code comment or a commit message.

## Bundle layout

The wiki is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
(OKF) bundle. `index.md` is **reserved**: in every directory it is a routing table with
**no frontmatter**. The exception is the bundle root `wiki/index.md`, whose only
frontmatter is `okf_version: "0.1"`.

Every other `.md` file is a note and carries YAML frontmatter:

```yaml
---
type: Decision
title: "Canonical dataset URL form"
description: "One sentence on what this note covers."
tags: [lucida, decision]
source_path: wiki/decisions/0042-canonical-dataset-url-form.md
created: 2026-04-18
modified: 2026-06-25
---
```

`type` is the only field OKF requires; the rest are conventions this bundle keeps.
`created` is set once and never hand-edited; `modified` bumps on every edit.

Filenames are kebab-case. Decisions are sequentially numbered (`0042-slug.md`).

## Link conventions

Cross-references are relative Markdown links resolved from the linking file's directory:

- `[Planning](planning.md)` — same directory
- `[Agent-first access](../principles/agent-first-access.md)` — another category

Link only to files inside this wiki, to `intention.md`, or to source files. Do not link
to articles you plan to write; add the content or leave it out.

## Article guardrails

**Hard rules**
- No code blocks longer than 3 lines. Link to the file instead (module path preferred).
- Every note states its rationale — the alternatives considered and why they lost.
- Don't recap the implementation. If an ADR needs to reference structure, name the
  module and move on; don't inventory its contents.

**Soft guidelines**
- Aim for ≤ 200 lines of prose per note.
- Prefer durable claims ("the planning domain owns wanted-set computation") over details
  that rot ("uses BTreeMap with key X" — that belongs in code).

## When the code and the wiki disagree

**Trust the code.** An ADR records a decision that was made at a point in time; it does
not promise the decision still holds. If you find an ADR that has been superseded, mark
it superseded rather than rewriting it to match current behavior — the historical record
is the point.
