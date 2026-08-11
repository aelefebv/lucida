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
# CI uses dtolnay/rust-toolchain@stable which currently resolves to 1.95.
# Pinning here matches CI exactly. Bump when CI's stable advances.
#
# Pin the Debian SUITE to bookworm (`-slim-bookworm`, not the bare `-slim`):
# the bare tag floats to the newest Debian (now trixie, glibc 2.38), which made
# the release binary require GLIBC_2.38 while the bookworm-slim runtime ships
# glibc 2.36 — the server then failed to dynamically link ("GLIBC_2.38 not
# found") and never started. Keep the builder's glibc == the runtime's.
FROM rust:1.95-slim-bookworm AS rust-builder

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

# wasm-pack, pinned to an explicit version (precompiled binary; faster than
# `cargo install`). Must match the wasm-pack pin in .github/workflows/ci.yml
# so the container's lucida-core pkg is built by the SAME wasm-pack that CI's
# vitest resolves against (lucida-tm2). The upstream `installer/init.sh` can't
# be pinned — its served copy hardcodes an older version (was v0.13.1) — so
# fetch the tagged release tarball directly. musl builds are static, so they
# run fine on this glibc (bookworm) builder.
ARG WASM_PACK_VERSION=v0.15.0
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  target="x86_64-unknown-linux-musl" ;; \
      aarch64) target="aarch64-unknown-linux-musl" ;; \
      *) echo "unsupported arch for wasm-pack pin: $arch" >&2; exit 1 ;; \
    esac; \
    dir="wasm-pack-${WASM_PACK_VERSION}-${target}"; \
    curl -fsSL "https://github.com/rustwasm/wasm-pack/releases/download/${WASM_PACK_VERSION}/${dir}.tar.gz" \
      -o /tmp/wasm-pack.tar.gz; \
    tar -xzf /tmp/wasm-pack.tar.gz -C /tmp; \
    install -m 0755 "/tmp/${dir}/wasm-pack" /usr/local/bin/wasm-pack; \
    rm -rf /tmp/wasm-pack.tar.gz "/tmp/${dir}"; \
    wasm-pack --version

WORKDIR /workspace

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
COPY lucida-proxy/    ./lucida-proxy/
COPY lucida-server/   ./lucida-server/
COPY lucida-store/    ./lucida-store/

# Build the server binary (release). `-p lucida-server` keeps cargo from
# walking other workspace members' bin targets unnecessarily; the dep
# graph still pulls in lucida-core/-content/-protocol/-proxy/-store as
# library deps. `--locked` fails the build if Cargo.lock is out of sync
# with the manifests rather than re-resolving deps at image build time.
RUN cargo build --locked --release -p lucida-server

# Build the WASM artifact lucida-web depends on. The output directory
# (lucida-core/pkg) is exactly what lucida-web's
# `"lucida-core": "file:../lucida-core/pkg"` dependency resolves to.
# Everything after `--` is forwarded to the underlying `cargo build`.
# Best-effort only: wasm-pack's own pre-build `cargo metadata` runs
# unlocked and would silently repair a desynced Cargo.lock before the
# forwarded --locked could reject it. The hard lock gate is the
# `cargo build --locked` above, which fails this stage first.
RUN cd lucida-core && wasm-pack build --target web --out-dir pkg -- --locked

# Stage 2: node + pnpm SPA build.
# node:22-slim matches CI's `lts/*` (node 22 is the active LTS) and
# stays close to debian:bookworm-slim so the eventual runtime layer
# shares a libc family with the build layers.
FROM node:22-slim AS web-builder

# Corepack ships with node and shims pnpm/yarn/etc. lucida-web doesn't
# pin a pnpm version via `packageManager`, so we follow CI's choice
# (pnpm/action-setup@v4 with `version: 9`) for parity.
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /web

# The SPA package files. We need lucida-web/ AND the lucida-core/pkg/
# artifact from stage 1 (the package.json's
# `"lucida-core": "file:../lucida-core/pkg"` is a relative path).
COPY lucida-web/ ./lucida-web/
COPY --from=rust-builder /workspace/lucida-core/pkg ./lucida-core/pkg
# The release version, which `vite.config.ts` reads and stamps into every
# trace run's header. A container build is exactly where a field report
# comes from, so it must carry a real version rather than a placeholder.
COPY .release-please-manifest.json ./.release-please-manifest.json

WORKDIR /web/lucida-web

# Install + build. --frozen-lockfile makes the build fail loud if
# pnpm-lock.yaml drifted from package.json (matches CI).
RUN pnpm install --frozen-lockfile
RUN pnpm run build

# Stage 3: runtime.
FROM debian:bookworm-slim AS runtime

# Runtime deps: ca-certificates is required for outbound HTTPS to
# Google's OAuth/JWKS endpoints, GCS, and any other TLS hosts the
# proxy fetches from. Upgrade inherited packages first so release
# scans don't block on fixed CVEs from a stale parent-image layer.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy the binary and the SPA dist out of the builder stages.
COPY --from=rust-builder /workspace/target/release/lucida-server /usr/local/bin/lucida-server
COPY --from=web-builder  /web/lucida-web/dist                    /usr/share/lucida/web

# /var/lib/lucida is the canonical writable directory the k8s
# manifests mount a PVC at. Defaulting WORKDIR here keeps
# CWD-relative defaults (e.g. LUCIDA_DB_PATH=./lucida.db) landing in
# the right place when an adopter doesn't override.
WORKDIR /var/lib/lucida

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

ENTRYPOINT ["lucida-server"]
