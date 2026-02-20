# Contributing to Lucida

## Start Here
Before planning or coding, read in this order:

1. `AGENTS.md`
2. `SPEC.md`
3. Relevant `specs/roadmap/step-*.md`
4. `docs/protocol/README.md`
5. `docs/context/traceability.yaml`
6. `docs/context/status.md`

## Contribution Rules

1. Every PR should reference at least one spec file and one roadmap step.
2. Keep changes scoped to the target step acceptance criteria.
3. If behavior or design intent changes, update the relevant step sub-spec or add/update an ADR.
4. If implementation or tests move, update `docs/context/traceability.yaml`.

## Context and Traceability Maintenance

1. Keep `docs/context/index.yaml` in sync with major context artifacts.
2. Keep `docs/context/traceability.yaml` in sync with roadmap step status.
3. Use status values only from: `planned`, `in_progress`, `blocked`, `done`.
4. For `done` steps, include non-empty `implementation_paths` and `test_paths`.

## Validation
Run context checks before opening or updating a PR:

```bash
python3 scripts/check_context.py
python3 -m unittest tests/context/test_context_contracts.py -v
```

Run additional targeted tests for the touched subsystem (for example protocol tests if protocol contracts changed).

## Python Version Alignment
If a PR changes `pyproject.toml` `requires-python`, it must also update matching
Python pins in `.github/workflows/*.yml` (`python-version` and any `uv ... --python ...` commands).

## PR Handoff Expectations
Final PR summary should include:

1. Changed files.
2. Spec and step references.
3. Tests/checks run.
4. Remaining risks/TODOs.
5. Next recommended roadmap step.
