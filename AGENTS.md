# Lucida Agent Playbook

## Purpose
`AGENTS.md` is the first operational file to read at the start of each session. It tells coding agents and developers how to gather context, plan work, implement safely, and hand off changes.

## Context Retrieval Order
Agents SHOULD load context in this order before planning or coding:

1. `SPEC.md`
2. Relevant `specs/roadmap/step-*.md`
3. `docs/protocol/README.md`
4. Machine-readable protocol contracts:
   - `protocol/openrpc/lucida.v1.openrpc.json`
   - `protocol/schemas/**/*.schema.json`
   - `protocol/command-log/lucida.commandlog.v1.schema.json`
5. `docs/context/traceability.yaml`
6. `docs/context/status.md`

## A. Planning Workflow
Before proposing architecture or implementation decisions, agents SHOULD:

1. Retrieve context using the order above.
2. Identify target step and dependencies from `specs/roadmap/` and `docs/context/traceability.yaml`.
3. Extract and restate:
   - goals and non-goals
   - hard constraints
   - step scope and out-of-scope boundaries
   - protocol boundaries
   - current status and blockers
   - required test and acceptance gates
4. Produce a short grounding summary in planning responses that includes:
   - current step
   - immediate dependencies
   - known unknowns / assumptions

## B. Implementation Workflow
Before editing files, agents SHOULD:

1. Confirm the target step in `docs/context/traceability.yaml`.
2. Confirm affected interfaces, schemas, and tests.
3. Scope changes to that step's acceptance criteria.
4. Preserve compatibility boundaries defined by protocol/spec files.
5. Update `docs/context/traceability.yaml` and `docs/context/status.md` when completion state materially changes.

## Validation and Handoff
Before final handoff, agents SHOULD:

1. Run relevant tests and checks for touched areas (full suite only when requested).
2. Confirm changed files are trace-linked to a roadmap step.
3. Include in final handoff:
   - changed files
   - checks/tests run
   - remaining risks or TODOs
   - next recommended step

## Python Version Guardrail
When changing Python runtime requirements, agents SHOULD update both sides in the
same PR:

1. `pyproject.toml` `project.requires-python`
2. CI/runtime pins in `.github/workflows/*.yml` (`python-version` and any
   `uv ... --python ...` usage)

## Guidance Policy
This playbook is guidance-first.

1. Agents SHOULD follow these workflows by default.
2. If context artifacts are missing or contradictory, agents SHOULD ask clarifying questions and proceed with explicit assumptions when possible.
3. Agents SHOULD avoid hard-fail behavior unless safety, correctness, or explicit project policy requires stopping.

## Stop/Ask Triggers
Agents SHOULD stop and ask for clarification when any of the following occurs:

1. Contradiction between spec intent and protocol schema contracts.
2. Unclear roadmap-step ownership for the requested change.
3. Missing acceptance criteria needed to implement safely.
