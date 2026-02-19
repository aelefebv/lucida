# Lucida

Lucida is a lightweight, high-performance, cross-platform n-dimensional microscopy viewer.

## Start Here

For product and implementation context, read in this order:

1. `AGENTS.md`
2. `SPEC.md`
3. Relevant `specs/roadmap/step-*.md`
4. `docs/protocol/README.md`
5. `docs/context/traceability.yaml`
6. `docs/context/status.md`

## Repo Map

1. `SPEC.md`: top-level product spec and roadmap index.
2. `specs/roadmap/`: per-step sub-specs.
3. `protocol/`: machine-readable protocol contracts (OpenRPC + JSON Schema + command-log schema).
4. `docs/protocol/README.md`: human-readable protocol guide.
5. `docs/context/`: context index, traceability, invariants, status, glossary.
6. `docs/architecture/`: architecture references and component map.
7. `docs/adr/`: architecture decision records.
8. `python/lucida_sdk/protocol/`: protocol model generation and generated models.
9. `python/lucida_daemon/`: Step 07 daemon runtime orchestration package.
10. `tests/protocol/`: protocol contract tests.
11. `tests/daemon/`: Step 07 daemon behavior tests.
12. `tests/context/`: context-system tests.

## Context Validation

Run before opening/updating a PR:

```bash
python3 scripts/check_context.py
python3 -m unittest tests/context/test_context_contracts.py -v
```

## Contribution Guidance

See `CONTRIBUTING.md` for traceability and handoff expectations.
