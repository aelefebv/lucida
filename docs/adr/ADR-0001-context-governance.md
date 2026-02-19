# ADR-0001: Context Governance for Spec-Aligned Development

- Status: accepted
- Date: 2026-02-19

## Context
Lucida has strong product and protocol specs, but future coding agents and developers need a predictable way to find current truth, implementation status, and validation gates.

Without a context governance layer, spec drift and implementation ambiguity become likely as the codebase grows.

## Decision
Adopt a guidance-first context system with:

1. Root `AGENTS.md` as the operational playbook.
2. Machine-readable context indexes in `docs/context/index.yaml` and `docs/context/traceability.yaml`.
3. Human-readable status and invariants docs in `docs/context/`.
4. PR template fields for spec/step traceability.
5. Automated context checks via `scripts/check_context.py` and CI.

## Consequences
Positive:

1. Faster onboarding for agents and humans.
2. Better spec-to-implementation traceability.
3. Lower drift risk through lightweight automation.

Tradeoffs:

1. Contributors must maintain context files when behavior/status changes.
2. Minor documentation overhead per PR.

## Alternatives Considered

1. Roadmap-only governance:
   - rejected due to weak traceability and no automated drift checks.
2. Hard-fail governance for every mismatch:
   - rejected for now due to high friction during early build-out.
