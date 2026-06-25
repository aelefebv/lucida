---
type: Subsystem
title: "Deployment"
description: "The conceptual reference for \"how does lucida deploy work?\" The procedural counterpart is extras/deploy/RUNBOOK.md, which walks through first-time setup click-by-click."
tags: [lucida, subsystem]
source_path: wiki/systems/subsystems/deployment.md
created: 2026-05-13
modified: 2026-06-25
---

# Deployment

The conceptual reference for "how does lucida deploy work?" The procedural counterpart is `extras/deploy/RUNBOOK.md`, which walks through first-time setup click-by-click. This article explains *why* the deploy is shaped the way it is and *how the pieces hang together*; the runbook explains *what to do, in order*.

## Why a single image

The deploy unit is one container image carrying both the API binary (`lucida-server`) and the SPA dist (`lucida-web`). The same image runs in production via Kubernetes, in a developer's `docker run` for local use, and in a `cargo run --release`-based prod-like rehearsal.

This shape is forced by the auth design. [Backend-Mediated OAuth with Session Cookies](../../decisions/0016-backend-mediated-oauth-with-session-cookies.md) uses `HttpOnly` + `SameSite=Lax` session cookies, which block cross-origin POST/PATCH/DELETE — so the SPA and the API must share a hostname. Some single-origin shape is required. Three alternatives could deliver it (reverse-proxy sidecar, two images with Ingress path-routing, or one image serving both); [Single-Image Container with `ServeDir` is the Canonical Deploy Unit](../../decisions/0020-single-image-with-servedir.md) picks the single-image route because the SPA and the API are already version-coupled at the source level (`lucida-web/package.json` depends on `file:../lucida-core/pkg`), so splitting them at the container boundary would create a gap that cannot exist in the source.

The single-image decision also collapses three localhost personas onto one substrate:

- **Active developer** — `cargo run` + Vite on `:5173`. Vite proxies `/auth`, `/api`, `/admin`, `/ws` to `:9876`. The `ServeDir` route on `:9876` is unused.
- **Local user** — `docker run` the image, set `LUCIDA_AUTH=disabled` + `LUCIDA_INSECURE=1`, visit `localhost:9876`. One container, one port.
- **Prod-like rehearsal** — `cargo build --release && (cd lucida-web && pnpm run build) && cargo run --release`. The `ServeDir` route picks up `lucida-web/dist/` and serves it. Useful for debugging deploy issues without a registry round-trip.

The static-serve route is implemented in `lucida-server/src/static_serve.rs` and reads `LUCIDA_WEB_DIST` (default `./lucida-web/dist`; the `Dockerfile` bakes it to `/usr/share/lucida/web`). It re-stats the dist directory per request so devs who build the SPA mid-session see results without restarting; if the directory is missing it serves a build-instructions landing page rather than 404.

## Env-var contract reference

Every deployment-specific value lives in a `LUCIDA_*` environment variable. Renaming or repurposing one is a breaking change for self-hosters — these are part of the public configuration surface. The full reference, with defaults and common misconfigurations, lives in [OSS Config Defaults and the LUCIDA_* Env Var Contract](../../gotchas/oss-config-defaults.md); this article does not duplicate it. Categories:

- **Auth** — `LUCIDA_AUTH`, `LUCIDA_GOOGLE_*`, `LUCIDA_ALLOWED_HOSTED_DOMAINS`, `LUCIDA_ADMIN_EMAILS`, `LUCIDA_COOKIE_*`, `LUCIDA_INSECURE`.
- **Persistence** — `LUCIDA_DB_PATH`, `LUCIDA_DATA_DIR`, `LUCIDA_PROXY_CACHE_DIR`.
- **Network** — `LUCIDA_BIND`, `LUCIDA_OAUTH_REDIRECT_URI`.
- **Observability** — `LUCIDA_LOG_FORMAT`.
- **Web-serving** — `LUCIDA_WEB_DIST`.
- **Data backend** — no `LUCIDA_*` vars; cloud-credential env vars (e.g., `GOOGLE_APPLICATION_CREDENTIALS`, `AWS_*`) are honored where applicable. URLs are passed at dataset-open time, not at startup.

A specific safety mechanism worth surfacing here: `LUCIDA_AUTH` auto-detects from the bind address per [Auth Mode Auto-Detect by Bind Address](../../decisions/0018-auth-mode-auto-detect-by-bind-address.md). Loopback bind defaults to `disabled` (frictionless dev); non-loopback defaults to `google` (forces operators to configure credentials). The dangerous combination "disabled auth + non-loopback bind" is rejected at startup unless `LUCIDA_INSECURE=1` is also set. CLI flags override env vars where both exist (`--data-dir` beats `LUCIDA_DATA_DIR`); the gotcha catalogs the cases.

## Persistence model

A single `ReadWriteOnce` PVC at `/var/lib/lucida` holds both the SQLite database and the proxy cache:

- **`/var/lib/lucida/lucida.db{,-wal,-shm}`** — sessions, bookmarks, and any future server-stored state. Small (typically megabytes, not gigabytes).
- **`/var/lib/lucida/proxy-cache/`** — on-disk proxy chunks. Recomputable from upstream sources; the variable that dominates sizing.
- **`/var/lib/lucida/data/`** — optional dataset directory, when `LUCIDA_DATA_DIR` is set. Read-only from lucida's perspective.

Single-replica only. SQLite + WAL is single-writer, and the proxy cache is also single-writer; running two pods against the same PVC double-books the writer slot. The reference Deployment uses `strategy: Recreate` so the new pod waits for the old pod to release the volume during rollouts. Multi-replica would require migrating to a real RDBMS first — explicitly out of scope for v1.

**SQLite-WAL backup gotcha.** The WAL file is part of the authoritative state. A naive file-copy of `lucida.db` while writes are in flight gives a torn snapshot. The two safe paths are `sqlite3 lucida.db ".backup '...'"` (consistent regardless of WAL state) or quiesce-then-snapshot (scale to 0 replicas, snapshot the volume, scale back). The runbook §"Backup considerations" enumerates tooling pointers (Velero, k8up, cloud-native VolumeSnapshot APIs); this article deliberately does not pick one.

## OAuth provider setup

The v1 supported provider is Google. The flow shape: the operator registers an OAuth Web Application client in Google Cloud Console, configures `https://<host>/auth/callback` as the redirect URI (Google compares the string verbatim), and supplies `LUCIDA_GOOGLE_CLIENT_ID` / `LUCIDA_GOOGLE_CLIENT_SECRET` / `LUCIDA_OAUTH_REDIRECT_URI` to the container. Lucida runs the standard Authorization Code exchange server-side, validates the JWT against Google's JWKS (cached for 24h with on-validation-failure refresh), enforces an optional `LUCIDA_ALLOWED_HOSTED_DOMAINS` allowlist against the JWT's `hd` claim, and creates a `lucida_session` cookie. See `extras/deploy/RUNBOOK.md` §2 for the click-by-click in Cloud Console.

### The `PrincipalExtractor` extensibility seam

Adding a different identity provider (Microsoft / Azure AD, Okta, GitHub OAuth, Authentik, generic OIDC) is a single-PR contribution per provider. The seam is the `PrincipalExtractor` trait in `lucida-server/src/auth/principal.rs` — `extract(req) -> Result<AuthPrincipal, AuthError>`. Saved-views (PRD #454) and any future identity-consuming feature depend only on the trait, not on Google. A new implementation lives next to `SessionCookieExtractor` and `GoogleJwtPrincipalExtractor`; the env-var contract grows by one accepted value of `LUCIDA_AUTH` (e.g., `microsoft`) plus any provider-specific config. Today only Google is implemented; the seam is documented for contributors per [Configurable From Day One for OSS Release](../../decisions/0017-configurable-from-day-one-for-oss-release.md). Unknown values of `LUCIDA_AUTH` fail loudly at startup rather than silently falling through to `Disabled` — see the gotcha "Microsoft auth value doesn't work" in [OSS Config Defaults and the LUCIDA_* Env Var Contract](../../gotchas/oss-config-defaults.md).

The auth subsystem itself is documented in [Authentication](auth.md); the deployment article complements it with the deploy-time perspective.

## Data backend dispatch

The dataset URL passed to `lucida-store::backend::open` selects the storage backend by URL scheme (the scheme-dispatch match in the `open` fn in `lucida-store/src/backend.rs`):

- `gs://bucket/path` → Google Cloud Storage via Application Default Credentials
- `s3://bucket/path` → Amazon S3 via `AmazonS3Builder::from_env()` (env credentials, instance profile, etc.)
- `http(s)://...` → HTTP static file server (no credentials)
- `/path` (or `file://`-prefixed) → local filesystem under that prefix

The backend is per-dataset, not per-deployment — one running server can open `gs://`, `s3://`, and local-path datasets in the same session. Operators wire identity per cloud:

- **GKE** — Workload Identity. Annotate the KubernetesServiceAccount with `iam.gke.io/gcp-service-account: <GSA-EMAIL>`; bind `roles/iam.workloadIdentityUser` on the GSA for the KSA principal; grant the GSA bucket-level IAM (e.g., `roles/storage.objectViewer`).
- **EKS** — IRSA. Annotate the KSA with `eks.amazonaws.com/role-arn: <ROLE-ARN>`; the role's trust policy allows the cluster's OIDC provider to assume it for `system:serviceaccount:<ns>:lucida`.
- **AKS** — Azure AD Workload Identity. Annotate the KSA with `azure.workload.identity/client-id` and label both the KSA and the pod with `azure.workload.identity/use: "true"`.
- **Self-hosted / on-prem** — env-creds fallback. Mount `GOOGLE_APPLICATION_CREDENTIALS` for GCS, set `AWS_*` env vars for S3, no credentials for `http(s)://` or local paths. Source the values from your in-cluster secret manager (Vault, Sealed Secrets, External Secrets Operator).

The runbook §5 "Cloud-specific identity wiring" carries the click-by-click bindings; this article documents the conceptual shape.

## Ingress and WebSocket upgrade

Lucida uses long-lived WebSockets for the document-relay + presence channel, and the SPA + API + auth + admin + WS routes all share a single backend. One Ingress with a `/`-prefix path covers everything. The shared concern across Ingress classes is the WebSocket upgrade: most controllers handle the HTTP/1.1 `Upgrade: websocket` handshake transparently when the backend protocol is HTTP, but their default idle/read timeouts (30-60s) silently drop idle WebSockets. Per-class tuning:

- **ingress-nginx** — `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"` plus `proxy-send-timeout`.
- **AWS ALB** — `alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=3600`. Sticky sessions are not required for lucida (single-replica), but the LB idle timeout is.
- **GKE Ingress** — attach a `BackendConfig` with `timeoutSec: 3600` via the `cloud.google.com/backend-config` annotation on the Service; `ManagedCertificate` for cert termination if not using cert-manager.
- **Traefik** — handles WS automatically; no Ingress-object annotations needed. Tune the upstream cloud LB's idle timeout if one fronts the cluster.
- **HAProxy** — `haproxy.org/timeout-server: "1h"` + `haproxy.org/timeout-tunnel: "1h"`.

The Ingress also terminates TLS, which interacts with cookie auto-detection. A TLS-terminating Ingress forwards `http://` to the pod; lucida's auto-detect of `Secure` looks at the request scheme, sees `http`, and won't mark cookies `Secure` — the browser then refuses to set the cookie on the `https` origin. We deliberately do NOT trust `X-Forwarded-Proto` (forgeable). Set `LUCIDA_COOKIE_SECURE=always` to force `Secure` cookies regardless of detected scheme. This is the single most common deploy-time auth failure; the reference manifest sets it unconditionally.

The actual annotation snippets per class live in `extras/deploy/k8s/ingress.yaml` (header comments). Adopters add what their controller needs in their own infra repo, per [Deployment Artifacts Are Reference Templates, Not Opinionated Infra](../../decisions/0021-deployment-artifacts-as-reference-templates.md).

## Operations

**Probes.** `/healthz` answers liveness ("is this process alive?") — the kubelet uses it to decide "kill and restart this pod." `/readyz` answers readiness ("should I send traffic here?") — the Service/LB uses it to decide routing. Both return `200 OK` with body `"ok"` today. The split is intentional even though they behave identically: future drain-on-shutdown semantics will flip readiness to 503 while liveness stays 200, so the LB stops routing while the kubelet doesn't restart the pod mid-drain. Both probes land on the public router half (no auth wrap) so the kubelet — which never presents a session cookie — can hit them. See `lucida-server/src/health.rs`.

**Log format.** `LUCIDA_LOG_FORMAT=text` (default) emits the dev-friendly pretty formatter; `LUCIDA_LOG_FORMAT=json` emits one JSON object per event, which Cloud Logging, Loki, Datadog, and similar aggregators consume natively. Production deployments set `json`; the reference manifest does this unconditionally. Auth subsystem audit events use the `dot.scope` event-name convention from [Logging Conventions](../../decisions/0012-logging-conventions.md) (e.g., `auth.signin.success`, `auth.session.expired.idle`); structured fields where applicable; cookie/JWT/state values are never logged.

**Metrics.** A Prometheus `/metrics` endpoint is **deferred** to a follow-on PRD per PRD #486 §"Out of Scope". Today, observability is logs + probes; metrics surface arrives separately.

## Release process

Releases are produced trunk-based via [release-please](https://github.com/googleapis/release-please). The maintainer merges Conventional Commits to `main`; release-please reads them, decides the semver bump (`feat:` → minor, `fix:`/`perf:` → patch, `BREAKING CHANGE:` → major; `docs:`/`chore:`/`style:`/`test:`/`ci:`/`refactor:` → no release), and opens or updates a "Release vX.Y.Z" PR with a generated `CHANGELOG.md` entry. **Auto-merge is OFF.** The maintainer manually merges that PR when a release is desired — this lets related changes batch into one release with one PR-click, per [Trunk-Based Releases via Manual-Merge `release-please` on `main`](../../decisions/0022-manual-merge-release-please-on-main.md). Merging the release PR pushes a tag (`vX.Y.Z`), which triggers the image-publishing workflow that builds and pushes a multi-arch image to `ghcr.io/<org>/lucida:vX.Y.Z`.

Adopters consume releases by **pinning image tags** in their manifests, not by tracking branches. The dev cluster pulls `:latest` (or `:main`); the prod cluster pins a specific release (e.g., `:v0.5.3`); promoting a release to prod is a `kubectl set image` (or manifest edit), not a `git merge`. Environment-branches as a promotion model (`dev` / `staging` / `prod` git branches) is a known anti-pattern lucida explicitly does not adopt — see [Branching and Releases](../../gotchas/branching-and-releases.md) for the full operational shape.

**`ghcr.io` package-visibility caveat.** When the source repository is public, the published package starts public — no action needed. When the source repository is private (a fork, a vendored copy in an internal monorepo), the published package starts **private by default**, even though it lives on `ghcr.io`. Anyone trying to `docker pull` it from outside the org gets `denied`. Flip to public via the GitHub UI: Package → Settings → Change visibility. This bites OSS adopters who fork to their own org and forget the visibility flip; the runbook §11 covers branch-protection prerequisites and mentions the package-visibility caveat for fork operators.

## Related

- [Backend-Mediated OAuth with Session Cookies](../../decisions/0016-backend-mediated-oauth-with-session-cookies.md) — the same-origin requirement that motivates single-image
- [Configurable From Day One for OSS Release](../../decisions/0017-configurable-from-day-one-for-oss-release.md) — OSS posture; PrincipalExtractor seam
- [Auth Mode Auto-Detect by Bind Address](../../decisions/0018-auth-mode-auto-detect-by-bind-address.md) — bind-address safety logic
- [Single-Image Container with `ServeDir` is the Canonical Deploy Unit](../../decisions/0020-single-image-with-servedir.md) — single-image deploy unit
- [Deployment Artifacts Are Reference Templates, Not Opinionated Infra](../../decisions/0021-deployment-artifacts-as-reference-templates.md) — manifests are reference templates, not packaged infra
- [Trunk-Based Releases via Manual-Merge `release-please` on `main`](../../decisions/0022-manual-merge-release-please-on-main.md) — release process shape
- [OSS Config Defaults and the LUCIDA_* Env Var Contract](../../gotchas/oss-config-defaults.md) — env-var contract reference
- [Branching and Releases](../../gotchas/branching-and-releases.md) — release / image-tag semantics
- [Authentication](auth.md) — the auth subsystem this article complements
- [lucida-server](../crates/lucida-server.md) — the runtime being deployed
- [lucida-store](../crates/lucida-store.md) — data backend dispatch
- `extras/deploy/docker-compose.yml` — single-host/homelab deploy option: same image, named volume at `/var/lib/lucida`, full `LUCIDA_*` env, `/readyz` healthcheck
- `extras/deploy/RUNBOOK.md` — procedural counterpart (first-time setup walkthrough)
