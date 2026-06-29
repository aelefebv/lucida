Start with the repo wiki at `wiki/index.md` (or `wiki/CLAUDE.md` for navigation conventions). The wiki captures intent, invariants, and gotchas across the codebase.

Use Conventional Commit subjects for all commits and squash-merge PR titles because `release-please` reads commits on `main`.

Pick a real fixture, not a toy one: lucida loads OME-Zarr lazily in chunks, so multi-GB 3D volumes and multi-channel timeseries open fast — dataset size is no reason to avoid them, and large/3D/timeseries data exercises far more of the viewer than a small 2D image.
