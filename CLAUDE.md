**Read `intention.md` first** — the north-star for what lucida is and who it's for (humans *and* LLM agents). Don't lose the plot: if a change makes lucida worse against it, it's the wrong change.

Then start with the repo wiki at `wiki/index.md` (or `wiki/CLAUDE.md` for navigation conventions). The wiki captures intent, invariants, and gotchas across the codebase.

`CONTEXT.md` at the root is the glossary — what each term means and which synonyms to avoid. Use its vocabulary in code, docs, issues, and commits.

Use Conventional Commit subjects for all commits and squash-merge PR titles because `release-please` reads commits on `main`.

Pick a real fixture, not a toy one: lucida loads OME-Zarr lazily in chunks, so multi-GB 3D volumes and multi-channel timeseries open fast — dataset size is no reason to avoid them, and large/3D/timeseries data exercises far more of the viewer than a small 2D image.

When verifying anything the viewer renders, test at `devicePixelRatio` 2 (retina), not just 1 — headless browsers default to 1 and it has hidden whole defect classes.

If `tsc` reports a missing method on a `Wasm*` type, `lucida-core/pkg` is stale — rebuild it with `pnpm build:wasm` from `lucida-web/`.

Keep everything domain-neutral. Do NOT use biology- or science-specific terms anywhere — code, identifiers, comments, docs, commits, PRs, issues, or test fixtures. lucida is a general n-dimensional array/image viewer, and the vocabulary should stay generalized across domains. Prefer neutral wording (e.g. "channel", "dataset", "volume", "sample", "label") over domain-loaded jargon.

## Agent skills

### Issue tracker

GitHub Issues on `aelefebv/lucida`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root is the glossary, and the decisions live in `wiki/` (principles + numbered ADRs) rather than `docs/adr/`. See `docs/agents/domain.md`.
