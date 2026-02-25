---
name: lucida-orchestrator
description: Vendor-neutral Lucida phase-1 orchestration skill for agent workflows. Use when an agent needs to operate the Lucida Rust daemon and Python CLI/client for dataset/session/view/render/export/import tasks, produce reproducible command or HTTP request templates, validate expected responses, or troubleshoot phase-1 API failures.
---

# Lucida Orchestrator

## Overview
Run Lucida phase-1 workflows through stable operation templates backed by the live repo contract.
Use this skill to choose the correct operation, execute it via CLI or HTTP, and verify expected outputs and failure modes.

## Preflight
1. Confirm daemon URL (`LUCIDA_BASE_URL` or default `http://127.0.0.1:3000`).
2. Confirm daemon is healthy (`GET /healthz`).
3. Prefer `uv run lucida ...` for operator-facing workflows.
4. Prefer HTTP templates when integrating with non-CLI agents.

## Operation Matrix
Read [references/operation-matrix.json](references/operation-matrix.json) first.
Treat operation IDs as stable phase-1 contract identifiers.

## Workflow
1. Select operation ID from the matrix.
2. Load matching CLI and HTTP templates from `templates/`.
3. Substitute deterministic placeholders (`<base_url>`, `<dataset_uri>`, `<session_id>`, `<view_id>`).
4. Execute the workflow and assert required response fields from the matrix.
5. On failure, map error code to [references/troubleshooting.md](references/troubleshooting.md).

## CLI Guidance
Use [references/phase1-cli.md](references/phase1-cli.md) and template files in `templates/cli/`.
Keep generated commands copy/paste safe and JSON-output oriented (`--json`) when downstream parsing is required.

## HTTP Guidance
Use [references/phase1-http.md](references/phase1-http.md) and template files in `templates/http/`.
Keep payloads schema-versioned (`schema_version: 1`) and endpoint-accurate for the current daemon routes.

## Troubleshooting
Use [references/troubleshooting.md](references/troubleshooting.md) for expected failure paths:
- `view_not_found`
- `unsupported_mode`
- `render_output_too_large`
- `invalid_request`

## Scope Guard
Stay in phase-1 only:
- In scope: dataset/session/view/render image/export/import + selector and camera helpers.
- Out of scope: render packs, probe/stats APIs, 3D rendering workflows.
