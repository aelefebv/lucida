# Lucida

A collaborative, domain-neutral viewer for large n-dimensional array/image
datasets. People and agents can open the same OME-Zarr dataset, navigate and
annotate it together, and stream only the chunks needed for the current view.
The server is Rust (Axum + Tokio); the interactive client is TypeScript +
WebGPU + WASM.

[![CI](https://github.com/aelefebv/lucida/actions/workflows/ci.yml/badge.svg)](https://github.com/aelefebv/lucida/actions/workflows/ci.yml)
[![Release](https://github.com/aelefebv/lucida/actions/workflows/release.yml/badge.svg)](https://github.com/aelefebv/lucida/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Quick start

### Run it locally (just you)

```bash
docker run --rm -p 127.0.0.1:9876:9876 \
  -e LUCIDA_AUTH=disabled -e LUCIDA_INSECURE=1 \
  ghcr.io/aelefebv/lucida:latest
```

Visit <http://localhost:9876>. The `127.0.0.1:` prefix on `-p` keeps the host's port forward bound to loopback so only your machine can reach it; the container itself still binds `0.0.0.0` internally (the Dockerfile defaults it that way), and `LUCIDA_INSECURE=1` acknowledges that auth is off (see [ADR-0018](wiki/decisions/0018-auth-mode-auto-detect-by-bind-address.md)).

### Share with your LAN

```bash
docker run --rm -p 9876:9876 \
  -e LUCIDA_AUTH=disabled -e LUCIDA_INSECURE=1 \
  ghcr.io/aelefebv/lucida:latest
```

Drops the `127.0.0.1:` prefix so the host port-forward listens on every interface — anyone on the same LAN can reach <http://your-machine:9876>. Be aware of the auth-off posture: browsers default to the admin `dev@local` identity, the profile menu can switch a browser to a different local dev identity for manual role testing, and admin endpoints (`/admin/clear-proxy-cache`) are unprotected. If you want real per-user authentication, use the auth-enabled scenario below.

### Run with sign-in (Google OAuth)

For any production-shape deployment — multi-user identity, proper admin gating, internet-reachable hostname — sign-in is required. The click-by-click Google Cloud Console setup (provision an OAuth client, configure the redirect URI, supply the credentials to the container) lives in [`extras/deploy/RUNBOOK.md`](extras/deploy/RUNBOOK.md) §2 alongside the Kubernetes manifests in [`extras/deploy/k8s/`](extras/deploy/k8s/) and the single-host docker-compose alternative in [`extras/deploy/docker-compose.yml`](extras/deploy/docker-compose.yml). The conceptual model (env-var contract, persistence layout, OAuth provider extensibility, per-cloud identity wiring) lives in [`wiki/systems/subsystems/deployment.md`](wiki/systems/subsystems/deployment.md).

### Develop on it

Prerequisites are pinned for reproducibility: Rust 1.95.0, Node 22.14.0,
pnpm 9.15.9, and wasm-pack 0.15.0. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for installation and upgrade policy.

One command brings everything up to date and runs both servers:

```bash
./scripts/dev.sh
```

It syncs the web deps from the frozen lockfile, verifies both the `lucida-core` WASM build inputs and the generated package fingerprint, builds `lucida-server`, then starts the relay server (binds `127.0.0.1:9876`, auth auto-disabled on loopback) and the Vite SPA dev server (which proxies `/auth /api /admin /ws/workspaces` to `:9876`), streaming both logs. `Ctrl-C` stops both cleanly. Pass `--wasm` to force a WASM rebuild. If an older dev process still owns either port, all builds are repaired first and the script prints the owning process; rerun with `--replace` to terminate cooperative listeners and launch the fresh pair.

Parallel worktrees can choose their own ports with `LUCIDA_DEV_BACKEND_PORT` and
`LUCIDA_DEV_WEB_PORT`. For a manually launched Vite instance, set
`LUCIDA_VITE_PROXY_TARGET` to a credential-free HTTP(S) origin such as
`http://127.0.0.1:9988`.

Then visit <http://localhost:5173>.

<details>
<summary>Prefer to run the two-terminal loop by hand?</summary>

One-time setup from the canonical `lucida-web` package boundary:

```bash
sh scripts/install-wasm-pack.sh "$HOME/.cargo/bin"
(cd lucida-core && wasm-pack build --target web --out-dir pkg -- --locked)
(cd lucida-web && corepack pnpm install --frozen-lockfile)
```

Terminal 1 — relay server (binds 127.0.0.1:9876, auth auto-disabled on loopback):

```bash
cargo run -p lucida-server
```

Terminal 2 — SPA dev server (Vite proxies /auth /api /admin /ws/workspaces to :9876):

```bash
(cd lucida-web && corepack pnpm run build:wasm && corepack pnpm install --frozen-lockfile && corepack pnpm run dev)
```

The WASM build runs before dependency installation so the local
`link:../lucida-core/pkg` package exists. Because the package is a live link and
is excluded from Vite dependency optimization, rebuilt WASM is visible without
copying dependencies or bypassing the cache. Generated Vite state under
`lucida-web/.vite` is ignored and never source-controlled.

Visit <http://localhost:5173>.

</details>

### Use the CLI and Python client

The product CLI command is `lucida`. From a source checkout, run the same binary by replacing `lucida` with `cargo run -p lucida-cli --`, for example `cargo run -p lucida-cli -- --server http://127.0.0.1:9876 status`.

To install the CLI from a checkout for repeated local use:

```bash
cargo install --locked --path lucida-cli
lucida --server http://127.0.0.1:9876 status
```

For an auth-disabled local server:

```bash
lucida --server http://127.0.0.1:9876 status
lucida --server http://127.0.0.1:9876 workspace list
lucida --server http://127.0.0.1:9876 workspace create "local analysis"
lucida --server http://127.0.0.1:9876 workspace use "local analysis"
lucida --server http://127.0.0.1:9876 workspace open --no-browser
lucida --server http://127.0.0.1:9876 workspace pin
lucida --server http://127.0.0.1:9876 workspace share show
```

For protected deployments, authenticate first:

```bash
lucida --server https://lucida.example.org auth login
lucida auth whoami
```

To open a dataset and verify it in the browser, keep a browser on the workspace URL printed by `workspace open`, then run:

```bash
lucida dataset browse /var/lib/lucida/data
lucida dataset open /var/lib/lucida/data/sample.ome.zarr
lucida dataset list
lucida viewer state
lucida viewer screenshot current-view.png
```

The already-open browser workspace should update when `dataset open`, layout, saved-view, or other shared workspace commands land. View, camera, layer, and channel commands update the selected durable headless viewer profile by default, and can also broadcast ephemeral presence while connected. `viewer screenshot`/`viewer overview` use the web renderer through Chrome/Chromium and wait for a nonblank canvas before writing the PNG.

Live peer following is intentionally ephemeral. To inspect or capture what an
already-open browser peer is looking at, run `lucida peer list` to find the
client id, then use `lucida viewer state --from-peer <client-id>`,
`lucida viewer screenshot --from-peer <client-id> peer-view.png`, or
`lucida viewer adopt --from-peer <client-id>` to copy that peer's current view
into the durable headless viewer profile.

Python scripts use the same server/client model:

```python
from lucida import LucidaClient

client = LucidaClient("http://127.0.0.1:9876")
workspace = client.workspaces.use("local analysis")
workspace.datasets.open("/var/lib/lucida/data/sample.ome.zarr")
print(workspace.datasets.list())
```

`LucidaClient` reads explicit constructor tokens, `LUCIDA_TOKEN`, macOS Keychain credentials created by `lucida auth login`, and the CLI-compatible config file. Default workspaces and config-file token fallback are scoped to the normalized server URL.

From a source checkout, run Python examples through the package environment:

```bash
uv run --project lucida-py python your_script.py
```

For a repeatable local smoke pass against a running server, set a server-visible dataset path and run:

```bash
export LUCIDA_SMOKE_SERVER=http://127.0.0.1:9876
export LUCIDA_SMOKE_DATASET=/var/lib/lucida/data/sample.ome.zarr
scripts/smoke_lucida_cli.sh
uv run --project lucida-py python scripts/smoke_python_client.py
```

The CLI smoke script isolates `LUCIDA_CONFIG_PATH` in a temp directory, creates a throwaway workspace, opens the dataset, checks dataset health, verifies structured diagnostics for missing/malformed dataset opens, mutates view/layer/channel state, runs debug/plan diagnostics, and validates screenshot/overview PNGs. Set `LUCIDA_SMOKE_CAPTURE=0` to skip browser-rendered captures when Chrome/Chromium is unavailable.

For a broader local fixture pass against Austin's test datasets, run a server
whose `--data-dir` can see `/Users/austin/local_data/lucida_test_zarrs`, then:

```bash
uv run --project lucida-py python scripts/smoke_dataset_reliability.py \
  --server "$LUCIDA_SMOKE_SERVER"
```

### Useful options

Add to any of the `docker run` recipes above.

**Mount a local data directory** so `/api/browse` can list OME-Zarr files on your filesystem. Without it, local browsing is disabled. Remote sources are separately deny-by-default and must be explicitly allowlisted with the `LUCIDA_SOURCE_*` settings described below.

```bash
-v /path/on/host:/var/lib/lucida/data \
  -e LUCIDA_DATA_DIR=/var/lib/lucida/data
```

**Persist workspaces/sessions across restarts** with a named volume covering the whole `/var/lib/lucida` tree (`lucida.db` + the generated-coarse cache, bounded to 8 GiB by default). Without this, `docker rm` wipes everything; matters most for the LAN-shared case where multiple people accumulate state:

```bash
-v lucida-data:/var/lib/lucida
```

Before upgrading a persistent deployment, follow
[`extras/deploy/RUNBOOK.md` §10](extras/deploy/RUNBOOK.md#10-updating-to-a-new-release):
stop the old writer, verify a WAL-safe backup, run the one-time Compose
UID/GID `10001:10001` volume helper when needed, and only then start the new
image. Rollback across the source-ID migration requires restoring that backup;
switching only the binary is unsafe.

### Reading remote datasets securely

Server-side source access is deny-by-default. Allow exact HTTP(S) hostnames
with `LUCIDA_SOURCE_HTTP_HOSTS`; add `LUCIDA_SOURCE_HTTP_CIDRS` only for
intentional private/LAN destinations. Standard IPv6 NAT64/transition forms are
rejected before transport pinning; list any operator-specific RFC 6052 prefix
in `LUCIDA_SOURCE_HTTP_IPV6_TRANSLATION_CIDRS` so it is denied too. Allow cloud scopes with
`LUCIDA_SOURCE_GCS_BUCKETS` or `LUCIDA_SOURCE_S3_BUCKETS`. Cloud credentials
are not used unless `LUCIDA_SOURCE_ALLOW_AMBIENT_CLOUD_CREDENTIALS=true` is
also set. These controls are cumulative with the identity permissions below.

### Reading from `gs://`

Lucida discovers Google Cloud credentials, in order: object_store-native `GOOGLE_SERVICE_ACCOUNT*` env vars, then `GOOGLE_APPLICATION_CREDENTIALS` (forwarded explicitly), then the well-known ADC file at `$HOME/.config/gcloud/application_default_credentials.json`, then the GCE metadata server. See [`wiki/gotchas/gcs-credentials.md`](wiki/gotchas/gcs-credentials.md) for the full story (and how to avoid the off-cluster ~13s metadata-server hang).

**Bare binary on a dev laptop** with `gcloud auth application-default login`
already done. Name the buckets Lucida may read and explicitly allow the
process to use ADC; the well-known file is then discovered automatically:

```bash
export LUCIDA_SOURCE_GCS_BUCKETS=my-dataset-bucket
export LUCIDA_SOURCE_ALLOW_AMBIENT_CLOUD_CREDENTIALS=true
cargo run -p lucida-server
```

**`docker run`** with the host's ADC file (or any service-account JSON) bind-mounted in:

```bash
docker run --rm -p 127.0.0.1:9876:9876 \
  -e LUCIDA_AUTH=disabled -e LUCIDA_INSECURE=1 \
  -e LUCIDA_SOURCE_GCS_BUCKETS=my-dataset-bucket \
  -e LUCIDA_SOURCE_ALLOW_AMBIENT_CLOUD_CREDENTIALS=true \
  -e GOOGLE_APPLICATION_CREDENTIALS=/gcp/adc.json \
  -v "$HOME/.config/gcloud/application_default_credentials.json:/gcp/adc.json:ro" \
  ghcr.io/aelefebv/lucida:latest
```

**GKE with Workload Identity** — annotate the KSA with the GSA email, set the
GCS bucket allowlist and ambient-credential opt-in in the Deployment, and
Lucida can discover the workload identity through the metadata server. Full
walkthrough in [`extras/deploy/RUNBOOK.md`](extras/deploy/RUNBOOK.md) §5.

## Working with the codebase

- **Rust changes in any `lucida-*` crate** → the SPA needs a fresh WASM build; `./scripts/dev.sh` rebuilds it automatically on restart, or rerun `(cd lucida-web && pnpm run build:wasm)` by hand
- **TypeScript changes in `lucida-web/`** → Vite hot-reloads automatically
- **Python binding changes in `lucida-py/`** → `(cd lucida-py && maturin develop)`

Run the CI-equivalent local verification:

```bash
./scripts/verify.sh
```

For a narrow web-only pass, type-check with `(cd lucida-web && pnpm exec tsc
--noEmit -p tsconfig.app.json)` — see
[`wiki/gotchas/ts-typecheck-trap`](wiki/gotchas/ts-typecheck-trap.md) for why
the project flag is load-bearing.

## Architecture

The wiki under [`wiki/`](wiki/) is the primary reference — start at [`wiki/index.md`](wiki/index.md) (or [`wiki/CLAUDE.md`](wiki/CLAUDE.md) for navigation conventions).

For *why* something is shaped the way it is, look in [`wiki/decisions/`](wiki/decisions/) (numbered ADRs). For *what bites you when you don't expect it*, look in [`wiki/gotchas/`](wiki/gotchas/).

## Project contracts

- [Contributing and verification](CONTRIBUTING.md)
- [Compatibility and supported boundaries](COMPATIBILITY.md)
- [Support](SUPPORT.md)
- [Private security reporting and supported versions](SECURITY.md)

## License

MIT — see [`LICENSE`](LICENSE).
