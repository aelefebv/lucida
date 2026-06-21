Start with the repo wiki at `wiki/index.md` (or `wiki/CLAUDE.md` for navigation conventions). The wiki captures intent, invariants, and gotchas across the codebase.

Use Conventional Commit subjects for all commits and squash-merge PR titles because `release-please` reads commits on `main`.

When you make a change, verify it actually works with the tryout harness in `extras/tryout/` — it spins lucida up from your working tree and exercises the web, CLI, and Python surfaces, saving screenshots and logs. Run `python3 extras/tryout/tryout.py report --fixture <dataset.ome.zarr>` for a full cross-surface check (writes a self-contained `report.html` + per-surface logs to a gitignored `.tmp/tryout/<ts>/`), or `up` / `drive --surface web|cli|python` for narrower checks. Don't rely on unit tests alone for surface behavior. See `extras/tryout/README.md`.

Pick a real fixture, not a toy one: lucida loads OME-Zarr lazily in chunks, so multi-GB 3D volumes and multi-channel timeseries open fast — dataset size is no reason to avoid them, and large/3D/timeseries data exercises far more of the viewer than a small 2D image.
