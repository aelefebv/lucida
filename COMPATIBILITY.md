# Compatibility

## Browser and graphics support

The primary interactive target is the current stable desktop Chromium family
on macOS, Linux, and Windows with WebGPU enabled. A working WebGPU adapter is
required for the full viewer. Safari and Firefox are best-effort until their
WebGPU implementations and this repository's real-browser CI coverage support
the same guarantees. Touch, mobile, software-only graphics, and accessibility
behavior should not be assumed supported unless a release note says otherwise.
CI exercises the production SPA in current stable Chromium at both DPR 1 and
DPR 2 against a real, multi-channel non-`u16` OME-Zarr fixture. It requires an
advancing content frame, nonblank canvas pixels, the expected channel/contrast
metadata, and clean GPU diagnostics; this is the compatibility floor for the
Chromium target rather than a page-load-only claim.

## Data and storage support

The viewing path supports OME-Zarr 0.5 data stored as Zarr v3, including single
images, multiscales, labels, and collections within the validated codec and
axis subsets documented in the wiki. Local files plus `file://`, `http(s)://`,
`s3://`, and `gs://` backends are supported. TIFF files and tiled TIFF
directories are ingest inputs converted to OME-Zarr; direct TIFF viewing is not
the public contract. Unsupported codecs or malformed metadata should fail with
diagnostics rather than render guessed data.

Trusted library and `PyStore` local-file access is supported on macOS, Linux,
and Windows, with a native Windows compile-and-read gate in CI. Server-admitted
local roots use a separate descriptor-confined capability that rejects
descendant symlinks; configuring those roots fails closed on platforms where
that confinement primitive is unavailable. This restriction does not turn the
trusted local library/Python backend into a server security boundary.

The exact codec, chunk-key, axis, and wire constraints live in
`wiki/systems/crates/lucida-store.md` and its linked gotchas. Those pages are
more specific than this summary.

## Client, server, and deployment support

The web client, server, CLI, and Python client are released from one source tree
and are tested together against one live server and fixture in CI. Cross-version wire compatibility is not guaranteed
before 1.0; update clients and server together unless release notes explicitly
document compatibility. The canonical container targets Linux amd64 and arm64.
The Kubernetes templates assume one replica and a ReadWriteOnce volume because
the current persistent store is SQLite. CI schema-validates the templates
against Kubernetes 1.36.2; the manifests use stable APIs, but operators targeting
an older or newer cluster must validate the copied templates against that
cluster's version and admission policies.

Supported build tools are pinned in `rust-toolchain.toml`, `.node-version`,
`lucida-web/package.json`, and `lucida-py/pyproject.toml`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the exact local setup and verification
command.

## Operational build identity

`GET /version` and `lucida-server --version` report the same compile-time
product identity. Release images inject the immutable `v*` Git tag, while CI
images use `ci-<commit SHA>`. An ad-hoc Cargo or Docker build is marked
`0.2.0+source`; the workspace's intentionally frozen per-crate version is not
presented as a published product release. Monitoring and support tooling should
record this value when reporting an incident.
