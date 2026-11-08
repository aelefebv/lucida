# Lucida

A domain-neutral viewer for large n-dimensional array and image data, built for people and for agents. Point it at an OME-Zarr dataset, local or in object storage, and explore it in 2D or 3D without downloading it or waiting for it to open. People use the browser UI. Agents drive the same engine through the CLI and the Python client and capture what it renders. A Rust server (Axum, Tokio) serves a TypeScript, WebGPU, and WASM client.

[![CI](https://github.com/aelefebv/lucida/actions/workflows/ci.yml/badge.svg)](https://github.com/aelefebv/lucida/actions/workflows/ci.yml)
[![Release](https://github.com/aelefebv/lucida/actions/workflows/release.yml/badge.svg)](https://github.com/aelefebv/lucida/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Quick start

### Run it locally

```bash
docker run --rm -p 127.0.0.1:9876:9876 \
  -e LUCIDA_AUTH=disabled -e LUCIDA_INSECURE=1 \
  ghcr.io/aelefebv/lucida:latest
```

Visit <http://localhost:9876>. The image binds `0.0.0.0` inside the container, so running with auth off needs `LUCIDA_INSECURE=1`. The `127.0.0.1:` prefix keeps the host side on loopback. You are `dev@local`, with no admin rights. The identity switcher that grants them appears only when the server itself binds loopback, which never happens in a container. Run from source (see [Develop](#develop)) if you need it.

### Share with your LAN

Drop the prefix (`-p 9876:9876`) and anyone on your network can reach <http://your-machine:9876>. Everyone shares the one `dev@local` identity and edits the same state, and admin routes answer 403. For per-user sign-in, use one of the next two setups.

### Sign in with Google

Set `LUCIDA_AUTH=google`. [`extras/deploy/RUNBOOK.md`](extras/deploy/RUNBOOK.md) covers the OAuth client, the environment variables, the SQLite and PostgreSQL storage backends, and backups. It goes with the Kubernetes templates in [`extras/deploy/k8s/`](extras/deploy/k8s/) and the single-host [`docker-compose.yml`](extras/deploy/docker-compose.yml).

### Run behind Identity-Aware Proxy

```bash
docker run --rm -p 9876:9876 \
  -e LUCIDA_AUTH=iap \
  -e LUCIDA_IAP_AUDIENCE=/projects/PROJECT_NUMBER/global/backendServices/SERVICE_ID \
  ghcr.io/aelefebv/lucida:latest
```

Lucida runs no sign-in of its own here. It verifies the assertion IAP attaches to each request and reads the email from it. `LUCIDA_IAP_AUDIENCE` is required and must match the `aud` claim byte for byte, so copy it from the load balancer's backend service. Bearer tokens still work, so the CLI reaches an IAP-fronted server unchanged.

The RUNBOOK's [environment reference](extras/deploy/RUNBOOK.md#environment-variables) also covers two optional features: a JSON people directory that fills in names and pictures (`LUCIDA_DIRECTORY_URL`), and a storage health route for an external monitor (`LUCIDA_STATUS_PATH`).

### Useful options

Add these to any `docker run` above:

```bash
# Mount datasets and confine the file picker to them. Unset, it lists from /.
# With sign-in on, local datasets open only from these directories.
-v /path/on/host:/var/lib/lucida/data -e LUCIDA_DATA_DIR=/var/lib/lucida/data
# Keep state across restarts. The default lucida.db lands in the working
# directory, /var/lib/lucida. The proxy cache goes elsewhere unless moved.
-v lucida-data:/var/lib/lucida -e LUCIDA_PROXY_CACHE_DIR=/var/lib/lucida/proxy-cache
```

### Theme a deployment

Point `LUCIDA_THEME_FILE` at a JSON file to set the appearance a first visit opens in and to restyle theme tokens. In Docker, mount it, for example `-v $PWD/theme.json:/etc/lucida/theme.json:ro -e LUCIDA_THEME_FILE=/etc/lucida/theme.json`.

```json
{
  "defaults": { "theme": "light", "accent": "#0f8278", "density": "compact", "canvasBackground": "white" },
  "tokens": { "dark": { "--lc-bg": "#101014" }, "light": { "--lc-radius": "4px" } }
}
```

Every key is optional. `theme` is `dark`, `light`, or `system`; `accent` is a six-digit hex color or `indigo`, `blue`, `teal`, `green`, `amber`, `rose`; `density` is `comfortable` or `compact`; `canvasBackground` is `black`, `dark-gray`, `white`, or `theme`. Users can still change each, and their choice wins. `tokens` overrides any `--lc-*` token in [`tokens.css`](lucida-web/src/theme/tokens.css) under that preset only, except the ones a setting above decides (accent, control heights, canvas colors, motion). The server refuses to start if the file is malformed or names an unknown token. `GET /api/theme` serves the file without a session.

### Reading from `gs://`

Credentials are found in this order: `GOOGLE_*` environment variables (`GOOGLE_SERVICE_ACCOUNT*`, `GOOGLE_APPLICATION_CREDENTIALS`), the ADC file at `$HOME/.config/gcloud/application_default_credentials.json`, then the GCE metadata server. Off Google Cloud, provide one of the first two, or the metadata-server probe adds a hang of about 13 s before it gives up.

After `gcloud auth application-default login`, `cargo run -p lucida-server` needs no configuration, and on GKE neither does Workload Identity (RUNBOOK §5). In Docker, mount the file:

```bash
docker run --rm -p 127.0.0.1:9876:9876 \
  -e LUCIDA_AUTH=disabled -e LUCIDA_INSECURE=1 \
  -e GOOGLE_APPLICATION_CREDENTIALS=/gcp/adc.json \
  -v "$HOME/.config/gcloud/application_default_credentials.json:/gcp/adc.json:ro" \
  ghcr.io/aelefebv/lucida:latest
```

## Writing data for lucida

lucida reads OME-Zarr stores (0.5 on Zarr v3, or 0.4 on Zarr v2) lazily, one chunk at a time, so the chunk, shard, and pyramid layout a writer chooses decides how many reads a view costs. The [data layout guide](docs/data-layout.md) recommends a layout and says which viewer behavior each choice serves.

## CLI and Python client

The `lucida` CLI and the `lucida` Python package drive a running server. `lucida --help` lists the commands, and each subcommand has its own `--help`. Dataset paths are paths the server can see, not the client.

```bash
cargo install --locked --path lucida-cli    # or: cargo run -p lucida-cli -- <args>
lucida config set server https://lucida.example.org   # default: http://localhost:9876
lucida auth login                           # protected deployments only
lucida workspace create demo && lucida workspace use demo
lucida dataset open /var/lib/lucida/data/sample.ome.zarr
lucida viewer screenshot view.png           # renders through a local Chrome or Chromium
```

```python
from lucida import LucidaClient

client = LucidaClient("http://127.0.0.1:9876")
workspace = client.workspaces.use("demo")
workspace.datasets.open("/var/lib/lucida/data/sample.ome.zarr")
workspace.view.pan(40, -20)
print(workspace.viewer.web_url)             # a page showing that view
```

View, camera, layer and channel changes from either client go to a viewer profile the server keeps, `default` unless you name another (`--viewer-profile` in the CLI, `workspace.viewer_profile` in Python), so they last after the call returns and a page opened at the profile's URL shows them. The Python client applies them through its compiled extension, so build it (below) before using them.

From a checkout, run scripts with `uv run --project lucida-py python your_script.py`. The client takes a token from its constructor, `LUCIDA_TOKEN`, the macOS Keychain entry `lucida auth login` writes, or the CLI config file.

Smoke passes against a running server: `scripts/smoke_lucida_cli.sh` and `scripts/smoke_python_client.py` read `LUCIDA_SMOKE_SERVER` and `LUCIDA_SMOKE_DATASET` (set `LUCIDA_SMOKE_CAPTURE=0` without Chrome), and `scripts/smoke_dataset_reliability.py --fixtures-root <DIR>` opens the fixture list in the script from `<DIR>`.

## Develop

Prerequisites: Rust, Node, pnpm, and wasm-pack.

```bash
./scripts/dev.sh
```

Then visit <http://localhost:5173>. The script rebuilds the `lucida-core` wasm package when Rust source content changed (`--wasm` forces it), installs web dependencies, starts `lucida-server` on `127.0.0.1:9876` with auth off, and starts Vite, which proxies `/auth`, `/api`, `/admin`, and `/ws` to it. Ctrl-C stops both.

By hand:

```bash
(cd lucida-web && pnpm run build:wasm && pnpm install)
cargo run -p lucida-server                                # terminal 1
(cd lucida-web && pnpm run dev)                           # terminal 2
```

`lucida-web` links `lucida-core/pkg` rather than copying it, so after a Rust change, rerun `pnpm run build:wasm` in `lucida-web` and reload the page. Rebuild the Python bindings with `(cd lucida-py && maturin develop)`.

```bash
# tests and type check
cargo test --workspace
(cd lucida-web && pnpm test)
(cd lucida-web && pnpm exec tsc --noEmit -p tsconfig.app.json)
```

Keep `-p tsconfig.app.json` on the type check. `lucida-web/tsconfig.json` is a solution file with `"files": []`, so a bare `tsc --noEmit` checks nothing and passes.

## Architecture

[`intention.md`](intention.md) says what lucida is for, and [`CONTEXT.md`](CONTEXT.md) defines its terms.

## License

MIT. See [`LICENSE`](LICENSE).
