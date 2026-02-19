# Step 10 Sub-Spec: Installers and CI Release Gates

## Objective
Deliver production-quality distribution artifacts and CI gates that enforce protocol/runtime quality across supported platforms.

## What Lives in This Sub-Spec
- Packaging strategy for Windows/macOS/Linux.
- Signing and distribution constraints.
- CI matrix, release criteria, and artifact publishing flow.
- Freshness checks for generated assets and schema contracts.

## Scope
In scope:
1. Desktop installer builds for all supported OSes.
2. Pip package publish path for Python SDK.
3. CI checks for protocol conformance, runtime tests, and performance budgets.

Out of scope:
1. Full auto-update framework.
2. Store-specific distribution automation beyond base channels.

## Interface and Contract Changes
- No new runtime protocol methods expected.
- Build and release interfaces become part of project operations contract.

## Deliverables
1. Packaging scripts/configuration.
2. CI workflows and release jobs.
3. Release checklist and gating policy docs.

## Test and Acceptance Gates
1. Platform builds are reproducible in CI.
2. Required test suites pass before release artifacts are published.
3. Generated protocol models and schemas pass freshness/integrity checks.

## Dependencies
- Steps 01-09 complete enough for distributable behavior.

## Exit Criteria
Step 10 is complete when signed installers and SDK artifacts can be produced reliably with enforced quality gates.
