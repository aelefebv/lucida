---
name: bottleneck-closer
description: Address a specified bottleneck listed in BOTTLENECKS.md (bottlenecks.md), then ship and merge it via GitHub. Use when the user asks to fix one numbered bottleneck, yeet it, merge back (resolving conflicts when needed), remove the completed bottleneck and all mentions of it from BOTTLENECKS.md, and clear BOTTLENECKS.md when no numbered bottlenecks remain.
---

# Bottleneck Closer

## Workflow

1. Read repo constraints: `CONTRIBUTING.md` (if present), `AGENTS.md` (if present), and `docs/SPEC.md`.
2. Read `BOTTLENECKS.md` and identify the requested bottleneck number/title.
3. Implement the bottleneck fix from first principles.
4. Add or update real tests that validate the change.
5. Edit `BOTTLENECKS.md` directly:
   - Delete the completed numbered bottleneck section.
   - Delete any other mention of that same bottleneck elsewhere in the file.
   - Do not renumber remaining bottlenecks or reorder remaining sections.
   - If no lines match `^### [0-9]+\\)` after deletion, clear `BOTTLENECKS.md` to an empty file so automation can repopulate it.
6. Run validation:
`cargo test --workspace`
`uv run pytest`
7. Yeet the change:
`gh --version`
`gh auth status`
If on a default branch, create `codex/<description>`.
Then run `git status -sb`, `git add -A`, `git commit -m "<description>"`, `git push -u origin <branch>`, and create a detailed draft PR with `gh pr create`.
8. Merge behavior:
   - If PR is mergeable without conflicts, mark ready and merge back immediately.
   - If PR has conflicts, fetch/rebase onto the target base branch, resolve conflicts, rerun tests, push with `--force-with-lease`, and then merge.

## PR Body Requirements

- Describe user-visible bottleneck symptoms.
- Explain root cause and why the prior implementation was slow/risky.
- Explain the fix and impact on behavior/performance.
- Include exact validation commands and results.
