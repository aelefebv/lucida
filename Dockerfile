# syntax=docker/dockerfile:1.7
#
# Lucida canonical deploy image.
# Per ADR-0020 (wiki/decisions/0020-single-image-with-servedir.md), one
# container bundles the API binary, the SPA dist, and the WASM pkg. The
# same image runs in production via Kubernetes, in a developer's
# `docker run` for local use, and in a `cargo run --release`-based
# prod-like rehearsal.
#
# Three stages:
#   1. rust + wasm-pack    -> lucida-server release binary, lucida-core wasm pkg
#   2. node + pnpm         -> lucida-web SPA dist (consumes the wasm pkg)
#   3. debian:bookworm-slim runtime carrying just the binary, the dist,
#      and the CA certs needed for outbound HTTPS (Google JWKS, GCS, ...).
#
# Distroless was considered and deferred: the slim-Debian variant keeps
# a shell available for diagnostics in v1.

# Stage 1: rust + wasm-pack.
# The workspace is on edition = "2024" (every member's Cargo.toml). 2024
# requires Rust >= 1.85; transitive deps (time@0.3.47, ...) need 1.88+;
# `rust-toolchain.toml` and CI pin 1.95.0 as the supported compiler.
#
# Pin the Debian SUITE to bookworm (`-slim-bookworm`, not the bare `-slim`):
# the bare tag floats to the newest Debian (now trixie, glibc 2.38), which made
# the release binary require GLIBC_2.38 while the bookworm-slim runtime ships
# glibc 2.36 — the server then failed to dynamically link ("GLIBC_2.38 not
# found") and never started. Keep the builder's glibc == the runtime's.
FROM rust:1.95-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082 AS rust-builder

# Build deps. We deliberately do NOT install libssl-dev: lucida-server's
# reqwest is configured `default-features = false, features =
# ["rustls-tls", ...]` and sqlx uses `runtime-tokio-rustls`, so the entire
# rust dep tree resolves through rustls. Skipping OpenSSL keeps the
# builder layer small and removes a CVE surface.
#
# pkg-config and the curl/ca-certs needed to fetch wasm-pack's installer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        pkg-config \
        ca-certificates \
        curl \
 && rm -rf /var/lib/apt/lists/*

# wasm32 target for wasm-pack to compile lucida-core into.
RUN rustup target add wasm32-unknown-unknown

WORKDIR /workspace

# CI and the image use the same installer, including the upstream-published
# release checksums for both supported image architectures.
COPY scripts/install-wasm-pack.sh ./scripts/install-wasm-pack.sh
RUN sh ./scripts/install-wasm-pack.sh /usr/local/bin

# Copy the workspace. .dockerignore keeps target/, node_modules/,
# lucida-core/pkg/, lucida-web/dist/, .git/, wiki/, extras/, lucida-py/,
# lucida.db*, secrets, etc. out of the build context.
# Cargo.lock is committed: this workspace ships release binaries
# (lucida-server, the lucida CLI) and this image, so the lock pins the
# full transitive dep graph. Copying it in and building `--locked`
# below makes an image rebuild of the same commit reproduce the same
# dependency set instead of silently re-resolving to newer versions.
COPY Cargo.toml Cargo.lock ./
COPY lucida-cli/      ./lucida-cli/
COPY lucida-content/  ./lucida-content/
COPY lucida-core/     ./lucida-core/
COPY lucida-protocol/ ./lucida-protocol/
COPY lucida-server/   ./lucida-server/
COPY lucida-store/    ./lucida-store/

# Product releases inject their Git tag here. The explicit source-build
# fallback prevents the frozen per-crate 0.2.0 metadata from masquerading as
# the deployed product release (ADR-0022).
ARG LUCIDA_BUILD_VERSION=0.2.0+source

# Build the server binary (release). `-p lucida-server` keeps cargo from
# walking other workspace members' bin targets unnecessarily; the dep
# graph still pulls in lucida-core/-content/-protocol/-proxy/-store as
# library deps. `--locked` fails the build if Cargo.lock is out of sync
# with the manifests rather than re-resolving deps at image build time.
RUN LUCIDA_BUILD_VERSION="${LUCIDA_BUILD_VERSION}" \
    cargo build --locked --release -p lucida-server

# Build the WASM artifact lucida-web depends on. The output directory
# (lucida-core/pkg) is exactly what lucida-web's
# `"lucida-core": "link:../lucida-core/pkg"` dependency resolves to.
# Everything after `--` is forwarded to the underlying `cargo build`.
# Best-effort only: wasm-pack's own pre-build `cargo metadata` runs
# unlocked and would silently repair a desynced Cargo.lock before the
# forwarded --locked could reject it. The hard lock gate is the
# `cargo build --locked` above, which fails this stage first.
RUN cd lucida-core && wasm-pack build --target web --out-dir pkg -- --locked

# Stage 2: node + pnpm SPA build.
# The exact Node release is shared with `.node-version`, package engines, and
# CI. The digest prevents a tag move from changing a rebuild of this commit.
FROM node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b AS web-builder

# Keep this exact value aligned with lucida-web/package.json `packageManager`.
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /web

# The SPA package files. We need lucida-web/ AND the lucida-core/pkg/
# artifact from stage 1 (the package.json's
# `"lucida-core": "link:../lucida-core/pkg"` is a relative path).
COPY lucida-web/ ./lucida-web/
COPY --from=rust-builder /workspace/lucida-core/pkg ./lucida-core/pkg

WORKDIR /web/lucida-web

# Install + build. --frozen-lockfile makes the build fail loud if
# pnpm-lock.yaml drifted from package.json (matches CI).
RUN pnpm install --frozen-lockfile
RUN pnpm run build

# Stage 3: runtime.
FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS runtime

# Runtime deps: ca-certificates is required for outbound HTTPS to
# Google's OAuth/JWKS endpoints, GCS, and any other TLS hosts the
# proxy fetches from. Upgrade inherited packages first so release
# scans don't block on fixed CVEs from a stale parent-image layer.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        coreutils \
        findutils \
 && groupadd --gid 10001 lucida \
 && useradd --uid 10001 --gid 10001 --no-create-home \
        --home-dir /var/lib/lucida --shell /usr/sbin/nologin lucida \
 && install -d -o 10001 -g 10001 /var/lib/lucida \
 && rm -rf /var/lib/apt/lists/*

# Copy the binary and the SPA dist out of the builder stages.
COPY --from=rust-builder /workspace/target/release/lucida-server /usr/local/bin/lucida-server
COPY --from=web-builder  /web/lucida-web/dist                    /usr/share/lucida/web

# /var/lib/lucida is the canonical writable directory the k8s
# manifests mount a PVC at. Defaulting WORKDIR here keeps
# CWD-relative defaults (e.g. LUCIDA_DB_PATH=./lucida.db) landing in
# the right place when an adopter doesn't override.
WORKDIR /var/lib/lucida
ENV HOME=/var/lib/lucida

# The dist path is image-internal (not adopter-tunable) so we bake it
# in. Everything else flows from runtime (`docker run -e ...` or k8s
# `env:`) per ADR-0017's OSS env-var contract.
ENV LUCIDA_WEB_DIST=/usr/share/lucida/web

# Bind 0.0.0.0 by default. ADR-0018's loopback default is for the
# binary running outside a container; the deploy unit's intent is "I'm
# exposed via a port forward," so the wildcard bind is the useful
# default here. Adopters who want a different bind override at runtime.
ENV LUCIDA_BIND=0.0.0.0:9876

# Informational; does not actually publish the port.
EXPOSE 9876

# Uses the server binary itself, so the probe cannot drift from the runtime
# image by depending on curl/wget being installed.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["lucida-server", "healthcheck"]

USER 10001:10001

ENTRYPOINT ["lucida-server"]
