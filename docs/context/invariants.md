# Context Invariants

These invariants should remain true unless explicitly changed by spec/ADR updates.

1. `SPEC.md` + `specs/roadmap/*.md` define product and step intent.
2. `protocol/` artifacts are canonical for command contracts.
3. Step status and implementation/test linkage live in `docs/context/traceability.yaml`.
4. `done` steps must map to concrete implementation and test paths.
5. `AGENTS.md` is the first operational context file for each session.
6. Context checks should pass in CI for merge readiness.
