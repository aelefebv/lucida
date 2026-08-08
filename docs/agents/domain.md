# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a **single-context** repo. Its domain docs do not sit in the default `CONTEXT.md` + `docs/adr/` layout — they live in `intention.md` and the `wiki/` tree.

## Before exploring, read these

- **`intention.md`** at the repo root — the north-star: what lucida is and who it's for. Read this first. If a change makes lucida worse against it, it's the wrong change.
- **`wiki/index.md`** — entry point to the wiki, with `wiki/CLAUDE.md` for navigation conventions.
- **`wiki/decisions/`** — the numbered ADRs (`0001-…` onward). Read the ones that touch the area you're about to work in; `wiki/decisions/index.md` lists them. `wiki/decisions/deferred.md` records choices deliberately postponed.
- **`wiki/principles/`** — stable claims about what each part of the product optimizes for. ADRs cite these.

The wiki records **why** lucida is shaped the way it is. It deliberately does not describe what the code currently does — for that, read the code. Nothing in the wiki is kept in sync with it.

There is no root `CONTEXT.md` or `CONTEXT-MAP.md`, and no `docs/adr/`. If `/domain-modeling` needs to record a new decision, add a numbered ADR under `wiki/decisions/` following the conventions in `wiki/CLAUDE.md` rather than creating a parallel `docs/adr/` tree.

## File structure

```
/
├── intention.md                       ← north-star
├── CLAUDE.md
└── wiki/
    ├── index.md
    ├── CLAUDE.md                      ← navigation + maintenance conventions
    ├── principles/                    ← what each part optimizes for
    └── decisions/                     ← numbered ADRs (0001-…), plus deferred.md
```

## Use the project's vocabulary

lucida is a general n-dimensional array/image viewer. Keep every output **domain-neutral** — no biology- or science-specific terms anywhere: code, identifiers, comments, docs, commits, PRs, issues, or test fixtures. Prefer neutral wording ("channel", "dataset", "volume", "sample", "label") over domain-loaded jargon.

When your output names a concept the wiki already defines (in an issue title, a refactor proposal, a hypothesis, a test name), use the wiki's term. Don't drift to synonyms it avoids. A concept with no name in the wiki is a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts wiki/decisions/0008 (CPU cache as sole fetch path) — but worth reopening because…_
