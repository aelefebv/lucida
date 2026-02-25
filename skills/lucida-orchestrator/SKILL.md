---
name: lucida-orchestrator
description: Vendor-neutral Lucida orchestration skill for agent workflows. Use when an agent needs to operate the Lucida Rust daemon and Python CLI/client for currently implemented dataset/session/view/render/export/import tasks, produce reproducible CLI or HTTP templates, validate expected responses, and troubleshoot API failures.
---

# Lucida Orchestrator

## Overview
Run currently implemented Lucida workflows through stable operation templates backed by the live repo contract.
Use this skill to choose the correct operation, execute it via CLI or HTTP, and verify expected outputs and failure modes.

## Preflight
1. Confirm daemon URL (`LUCIDA_BASE_URL` or default `http://127.0.0.1:3000`).
2. Confirm daemon is healthy (`GET /healthz`).
3. Confirm required tools are available (`uv --version`, `cargo --version`, `python --version`).
4. Prefer `uv run lucida ...` for operator-facing workflows.
5. Prefer HTTP templates when integrating with non-CLI agents.

## Operation Matrix
Read [references/operation-matrix.md](references/operation-matrix.md) first.
Use [references/operation-matrix.json](references/operation-matrix.json) for machine-readable operation metadata.
Treat operation IDs as stable identifiers for the currently implemented surface.

## Workflow
1. Select operation ID from the matrix.
2. Load matching CLI and HTTP templates from `templates/`.
3. Substitute deterministic placeholders (`<base_url>`, `<dataset_uri>`, `<session_id>`, `<view_id>`).
4. Execute the workflow and assert required response fields from the matrix.
5. On failure, map error code to [references/troubleshooting.md](references/troubleshooting.md).

## Validation Loop
1. Run `uv run python scripts/skills/validate_skill.py --skill skills/lucida-orchestrator`.
2. Run `uv run python scripts/skills/check_drift.py --skill skills/lucida-orchestrator`.
3. Run `uv run python scripts/skills/build_adapters.py --skill skills/lucida-orchestrator --out output/skills`.
4. If any step fails, fix the skill or templates and repeat from step 1.

## CLI Guidance
Use [references/current-cli.md](references/current-cli.md) and template files in `templates/cli/`.
Keep generated commands copy/paste safe and JSON-output oriented (`--json`) when downstream parsing is required.

## HTTP Guidance
Use [references/current-http.md](references/current-http.md) and template files in `templates/http/`.
Keep payloads schema-versioned (`schema_version: 1`) and endpoint-accurate for the current daemon routes.

## Troubleshooting
Use [references/troubleshooting.md](references/troubleshooting.md) for expected failure paths:
- `view_not_found`
- `unsupported_mode`
- `render_output_too_large`
- `invalid_request`

## Scope Guard
Stay within the currently implemented API surface defined by the operation matrix:
- In scope: operations listed in [references/operation-matrix.md](references/operation-matrix.md).
- Out of scope: any operation not listed there.
