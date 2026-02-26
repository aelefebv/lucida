# Lucida CLI Reference

Source of truth for command wiring:

- `src/lucida/commands/__init__.py`
- `src/lucida/commands/context.py`
- `src/lucida/commands/dataset.py`
- `src/lucida/commands/session.py`
- `src/lucida/commands/view.py`
- `src/lucida/commands/render.py`
- `src/lucida/commands/usage.py`
- `src/lucida/commands/lifecycle.py`

`lucida` is exposed via:

- `pyproject.toml` (`[project.scripts] lucida = "lucida.cli:main"`)
- `main.py` (`python main.py ...` uses the same CLI tree)

## Global

```bash
lucida [--install-completion] [--show-completion] [--help] COMMAND [ARGS]...
```

## Root Commands

```bash
lucida stop [--json] [--base-url TEXT]
lucida close [--json] [--base-url TEXT]   # alias of stop
lucida exit [--json] [--base-url TEXT]    # alias of stop
lucida context ...
lucida dataset ...
lucida session ...
lucida view ...
lucida render ...
lucida usage ...
```

## `context`

```bash
lucida context show [--json]
lucida context clear [--json]
```

## `session`

```bash
lucida session create [--json] [--base-url TEXT]
lucida session use --session-id TEXT [--json]
lucida session current [--json]
```

## `dataset`

```bash
lucida dataset open \
  --uri TEXT \
  [--dataset-id TEXT] \
  [--session-id TEXT] \
  [--full-raw-metadata] \
  [--json] \
  [--base-url TEXT]

lucida dataset use --dataset-id TEXT [--json]
lucida dataset current [--json]
```

## `view`

### Lifecycle + State Transfer

```bash
lucida view create \
  [--dataset-id TEXT] \
  [--session-id TEXT] \
  [--mode TEXT] \
  [--multiscale-name TEXT] \
  [--width-px INT] \
  [--height-px INT] \
  [--pixel-ratio FLOAT] \
  [--selectors-file PATH | --selectors-json TEXT] \
  [--view2d-file PATH | --view2d-json TEXT] \
  [--json] \
  [--base-url TEXT]

lucida view export \
  [--view-id TEXT] \
  [--session-id TEXT] \
  [--out PATH] \
  [--json] \
  [--base-url TEXT]

lucida view import \
  [--view-state-file PATH | --view-state-json TEXT] \
  [--session-id TEXT] \
  [--json] \
  [--base-url TEXT]

lucida view update \
  [--view-id TEXT] \
  [--patch-file PATH | --patch-json TEXT] \
  [--expected-state-version INT] \
  [--session-id TEXT] \
  [--json] \
  [--base-url TEXT]
```

### Selector Helpers

```bash
lucida view dim \
  [--view-id TEXT] \
  --axis TEXT \
  --index INT \
  [--session-id TEXT] \
  [--clamp | --no-clamp] \
  [--json] \
  [--base-url TEXT]

lucida view range \
  [--view-id TEXT] \
  --axis TEXT \
  --start INT \
  --end-exclusive INT \
  [--session-id TEXT] \
  [--clamp | --no-clamp] \
  [--json] \
  [--base-url TEXT]

lucida view indices \
  [--view-id TEXT] \
  --axis TEXT \
  --index INT [--index INT ...] \
  [--session-id TEXT] \
  [--clamp | --no-clamp] \
  [--json] \
  [--base-url TEXT]
```

### Navigation Helpers

```bash
lucida view plane \
  [--view-id TEXT] \
  --plane TEXT \
  [--session-id TEXT] \
  [--json] \
  [--base-url TEXT]

lucida view orthogonal \
  [--view-id TEXT] \
  [--enabled | --disabled] \
  [--session-id TEXT] \
  [--json] \
  [--base-url TEXT]

lucida view rotation \
  [--view-id TEXT] \
  --rotation-deg FLOAT \
  [--session-id TEXT] \
  [--json] \
  [--base-url TEXT]

lucida view pan \
  [--view-id TEXT] \
  --dx-px FLOAT \
  --dy-px FLOAT \
  [--session-id TEXT] \
  [--json] \
  [--base-url TEXT]

lucida view zoom \
  [--view-id TEXT] \
  --factor FLOAT \
  [--session-id TEXT] \
  [--json] \
  [--base-url TEXT]

lucida view rotate \
  [--view-id TEXT] \
  --delta-deg FLOAT \
  [--session-id TEXT] \
  [--json] \
  [--base-url TEXT]
```

### Inspection + Capture

```bash
lucida view state [--view-id TEXT] [--session-id TEXT] [--json] [--base-url TEXT]
lucida view selectors [--view-id TEXT] [--session-id TEXT] [--json] [--base-url TEXT]
lucida view camera [--view-id TEXT] [--session-id TEXT] [--json] [--base-url TEXT]
lucida view bounds [--view-id TEXT] [--session-id TEXT] [--json] [--base-url TEXT]

lucida view screenshot \
  [--view-id TEXT] \
  [--width-px INT] \
  [--height-px INT] \
  [--delivery inline_base64|file_path] \
  [--file-path PATH] \
  [--session-id TEXT] \
  [--request-id TEXT] \
  [--json] \
  [--base-url TEXT]
```

### Local Context Defaults

```bash
lucida view use --view-id TEXT [--json]
lucida view current [--json]
```

## `render`

```bash
lucida render image \
  [--view-id TEXT | --view-state-file PATH | --view-state-json TEXT] \
  --width-px INT \
  --height-px INT \
  [--delivery inline_base64|file_path] \
  [--file-path PATH] \
  [--session-id TEXT] \
  [--request-id TEXT] \
  [--patch-file PATH | --patch-json TEXT] \
  [--json] \
  [--base-url TEXT]
```

## `usage`

```bash
lucida usage events \
  [--limit INT] \
  [--before-id INT] \
  [--run-id TEXT] \
  [--endpoint TEXT] \
  [--status-code INT] \
  [--from-ts RFC3339] \
  [--to-ts RFC3339] \
  [--json] \
  [--base-url TEXT]

lucida usage runs \
  [--limit INT] \
  [--before-start-ts RFC3339] \
  [--json] \
  [--base-url TEXT]

lucida usage run \
  --run-id TEXT \
  [--event-limit INT] \
  [--json] \
  [--base-url TEXT]

lucida usage stream-url \
  [--run-id TEXT] \
  [--base-url TEXT]
```

## Environment Variables Used by CLI

- `LUCIDA_BASE_URL`: default API base URL when `--base-url` is not set.
- `LUCIDA_AGENT_RUN_ID`: optional header propagation for agent run correlation.
- `LUCIDA_AGENT_STEP_ID`: optional header propagation for agent step correlation.
- `LUCIDA_AGENT_NAME`: optional header propagation for agent name correlation.
- `LUCIDA_CLI_CONTEXT_PATH`: override local context state path.
- `LUCIDA_DAEMON_STATE_PATH`: override managed daemon state file path.
- `LUCIDA_DAEMON_CMD`: override daemon bootstrap command for local auto-start.

## Maintenance Workflow

When command definitions change:

1. Update command decorators/options in `src/lucida/commands/*.py`.
2. Update this document in the same PR.
3. Verify help output:

```bash
uv run lucida --help
uv run lucida context --help
uv run lucida dataset --help
uv run lucida session --help
uv run lucida view --help
uv run lucida render --help
uv run lucida usage --help
```
