---
created: 2026-05-13
modified: 2026-06-25
---

# Single-Image Container with `ServeDir` is the Canonical Deploy Unit

> Status: Accepted (implemented; PRD #486). `static_serve.rs`, the root `Dockerfile`, and `LUCIDA_WEB_DIST` all exist.

## Decision

`lucida-server` serves the SPA bundle (`lucida-web/dist`) directly via a `tower-http::ServeDir` route, with SPA-fallback to `index.html` for unknown paths and a "build the SPA first" landing page when the dist directory is missing or empty. The dist path is configurable via the new `LUCIDA_WEB_DIST` env var (default `./lucida-web/dist`). The production deploy unit is therefore a **single container image** that bundles both the API binary and the SPA assets at `/usr/share/lucida/web`. The same image runs in production via Kubernetes, in a developer's `docker run` for local use, and in a `cargo run --release`-based prod-like rehearsal.

## Why

The SPA and the API must share an origin in production because the auth design (`HttpOnly` + `SameSite=Lax` cookies; [[decisions/0016-backend-mediated-oauth-with-session-cookies]]) blocks cross-origin cookie writes on POST/PATCH/DELETE. Some single-origin shape is required.

Three alternatives could deliver single-origin:

1. **Reverse-proxy sidecar** (nginx serves the SPA, proxies API/WS to lucida-server). Two containers, two images, two health stories, two version-skew possibilities. Operationally heavier without proportional benefit at lucida's scale.
2. **Two separate images** with deployment-time path-routing on the Ingress. Same problems as the sidecar plus the Ingress now carries the routing knowledge that should live in the deployment artifact itself.
3. **Single image serving both** via `ServeDir` baked into lucida-server. One thing to build, version, scan, and deploy. The SPA and the API are versioned together and cannot drift.

(3) is the right shape because lucida is shipped as one cohesive product (the chunk pipeline straddles WASM-on-the-server-build-side and JS-on-the-client-side anyway — they are already tightly version-coupled by `lucida-web/package.json`'s `"lucida-core": "file:../lucida-core/pkg"` dependency). Splitting them at the container boundary creates a gap that cannot exist in the source code.

The same decision also collapses three localhost personas onto a clean substrate:

- **Active developer** — unchanged. `cargo run` + Vite dev server on `:5173`. Vite proxies `/auth`, `/api`, `/admin`, `/ws` to `:9876`. The `ServeDir` route on `:9876` is not visited.
- **Local user** — `docker run` the image, set `LUCIDA_AUTH=disabled` + `LUCIDA_INSECURE=1`, visit `localhost:9876`. One container, one port, no toolchain setup.
- **Production-like rehearsal without docker** — `cargo build --release && (cd lucida-web && pnpm run build) && cargo run --release`. The `ServeDir` route picks up `lucida-web/dist/` and serves it. Useful for debugging deploy issues without a registry round-trip.

## Alternatives considered

- **Distroless runtime image with no `ServeDir`, leaving SPA serving to the Ingress.** Rejected — punts the single-origin problem onto every adopter and effectively forces (1) or (2) above. Distroless itself remains a future hardening option and is independent of this decision.
- **Build-time inlining of the SPA into the binary** (e.g., `include_dir!`). Rejected — bloats the binary, prevents debug-rebuild of the SPA against an existing server, complicates the "missing dist returns build instructions" UX. `ServeDir` reading from a runtime path is more flexible without measurable cost.
- **Make the dist path non-configurable** (hardcoded `./lucida-web/dist` for cargo, hardcoded `/usr/share/lucida/web` for docker via a build-time `cfg!`). Rejected — adds a compile-time flag for no operational benefit. One env var with a sensible default covers both.

## Consequences

- The Dockerfile gains a `node:lts` stage that builds the SPA against the WASM artifact from the rust stage. The build sequence is non-trivially ordered (WASM before SPA before runtime), which is the cost of bundling.
- The SPA build (`pnpm run build`) must succeed cleanly. The three pre-existing TypeScript errors documented in [[gotchas/preexisting-ts-build-errors]] become a hard blocker that the deployment work clears as a prerequisite slice.
- The "missing dist" landing page is a small piece of UX surface that does not exist today and must not be skipped — without it, a stale local checkout produces a blank page rather than an actionable message.
- The dev workflow gains a small invariant: visiting `:9876` directly will work but serve whatever the SPA dist directory contains (possibly empty / stale). Devs visit `:5173` for hot-reload; this is unchanged but worth knowing.
- `lucida-server` now has a static-asset responsibility. The new `static_serve` module owns it; main.rs does not gain SPA-serving logic of its own.

## How this decision shows up in code

- `lucida-server/src/static_serve.rs` (new) — `pub fn router(dist_path: PathBuf) -> Router` plus the missing-dist landing handler.
- `lucida-server/Cargo.toml` — `tower-http` gains the `fs` feature alongside the existing `cors`.
- `lucida-server/src/main.rs` — reads `LUCIDA_WEB_DIST`, calls `static_serve::router(...)`, merges last so it acts as the catch-all.
- `Dockerfile` (new) — multi-stage: rust + `wasm-pack` → node + pnpm → slim runtime. SPA dist copied to `/usr/share/lucida/web`; Deployment manifest sets `LUCIDA_WEB_DIST` to that path.
- `extras/deploy/k8s/deployment.yaml` — `LUCIDA_WEB_DIST=/usr/share/lucida/web` env var.

## Related

- PRD #486 — implementation specification
- [[decisions/0016-backend-mediated-oauth-with-session-cookies]] — the same-origin requirement this decision answers
- [[decisions/0017-configurable-from-day-one-for-oss-release]] — `LUCIDA_WEB_DIST` follows the established env-var contract
- [[gotchas/preexisting-ts-build-errors]] — the prerequisite that becomes a hard blocker
- [[decisions/0021-deployment-artifacts-as-reference-templates]] — reference manifests consume this image
- [[lucida-server]] — the crate gaining static-asset responsibility
- [[lucida-web]] — the SPA whose dist is being served
