`intention.md` says what lucida is and who it serves, humans and LLM agents alike. Judge a
change against it.

`CONTEXT.md` is the glossary. Use its terms in code, docs, issues, and commits.

Keep everything domain-neutral. lucida is a general n-dimensional array and image viewer, so
code, identifiers, comments, docs, commits, PRs, issues, and test fixtures use neutral words
("channel", "dataset", "volume", "sample", "label") and no biology- or science-specific terms.

Use Conventional Commit subjects for commits and squash-merge PR titles. release-please reads
them on `main`.

Test with real fixtures. lucida loads OME-Zarr lazily in chunks, so multi-GB 3D volumes and
multi-channel timeseries open fast and exercise far more of the viewer than a small 2D image.

Verify anything the viewer renders at `devicePixelRatio` 2 as well as 1. Headless browsers
default to 1, and that has hidden whole classes of defects.

If `tsc` reports a missing method on a `Wasm*` type, `lucida-core/pkg` is stale. Rebuild it
with `pnpm build:wasm` from `lucida-web/`.

Comments say why: the invariant, the constraint, the choice a reader would otherwise undo.
History and issue numbers belong in commit messages.

## Issues

GitHub Issues on `aelefebv/lucida`, through `gh`. See `docs/agents/issue-tracker.md`.
