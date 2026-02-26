---
name: bottleneck-closer
description: Implement and close a specified performance bottleneck listed in BOTTLENECKS.md, then ship it via GitHub PR. Use when the user asks to tackle a named/numbered bottleneck item, remove the completed item from BOTTLENECKS.md, run project tests, and complete a merge (including conflict resolution if needed).
---

# Bottleneck Closer

## Workflow

1. Read repo constraints: `CONTRIBUTING.md` (if present), `AGENTS.md` (if present), and `docs/SPEC.md`.
2. Read `BOTTLENECKS.md` and identify the requested bottleneck number/title.
3. Implement the bottleneck fix from first principles.
4. Add or update real tests that validate the change.
5. Remove the completed bottleneck from `BOTTLENECKS.md` with:
`uv run python skills/bottleneck-closer/scripts/prune_bottlenecks.py --file BOTTLENECKS.md --remove <number-or-title>`
6. Run validation:
`cargo test --workspace`
`uv run pytest`
7. Yeet the change:
`gh --version`
`gh auth status`
If on a default branch, create `codex/<description>`.
Then run `git status -sb`, `git add -A`, `git commit -m "<description>"`, `git push -u origin <branch>`, and create a detailed draft PR with `gh pr create`.
8. Merge behavior:
If PR is mergeable, mark ready and merge.
If PR is conflicting, fetch/rebase onto `origin/main`, resolve conflicts, rerun tests, push with `--force-with-lease`, and merge.

## BOTTLENECKS.md Rules

- Always remove the completed bottleneck entry from `BOTTLENECKS.md`.
- After removal, if no bottleneck headings remain, clear `BOTTLENECKS.md` to an empty file so automation can repopulate it.
- Use the bundled script to preserve numbering and suggested implementation order consistency.

## PR Body Requirements

- Describe user-visible bottleneck symptoms.
- Explain root cause and why the prior implementation was slow/risky.
- Explain the fix and impact on behavior/performance.
- Include exact validation commands and results.
