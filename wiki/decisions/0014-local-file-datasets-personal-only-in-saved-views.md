---
type: Decision
title: "Local-File Datasets Are Personal-Only in Saved Views"
description: "A saved view (URL-as-App-State for Saved Views) that references local-file datasets — paths like /data/scans/foo.zarr, c:/users/me/foo.zarr, or //server/share/foo.zarr, identified by lucida_content::url::is_local_data…"
tags: [lucida, decision]
source_path: wiki/decisions/0014-local-file-datasets-personal-only-in-saved-views.md
created: 2026-05-07
modified: 2026-06-25
---

# Local-File Datasets Are Personal-Only in Saved Views

> Status: Accepted (implemented in PR #478 via `ShareToolbarButton.tsx`'s local-file warning toast — landed 2026-05-08).

> Amended 2026-05-26 by [Canonical dataset URL form](0042-canonical-dataset-url-form.md): the local-path classifier is now `is_local_dataset_url(normalize_dataset_url(s))`, extended to cover drive-letter (`c:/…`) and UNC (`//server/share/…`) canonical forms. The personal-only-share decision and the `DatasetId`-blake3-collision sharp edge below remain valid verbatim.

## Decision

A saved view ([URL-as-App-State for Saved Views](0013-url-as-app-state-for-saved-views.md)) that references local-file datasets — paths like `/data/scans/foo.zarr`, `c:/users/me/foo.zarr`, or `//server/share/foo.zarr`, identified by `lucida_content::url::is_local_dataset_url` after `normalize_dataset_url` — is treated as a *personal* artifact: it works for the sender refreshing on the same `lucida-server`, but is documented and warned-about as fragile when shared across machines.

The web client surfaces a non-blocking warning at share time when the current URL contains local-file paths: "This view references local files (N paths) — link only works on a server with the same files at the same paths."

No automatic conversion (e.g. server starts serving the local file via HTTP under a stable URL) is performed.

## Why

"Local file" in lucida means a file on the **server's** filesystem, not the browser's sandbox. The path string flows from the web client's `FileBrowser` (which fetches `/api/browse` from the server) directly into `OpenRemoteDataset { url }`, where the server's `lucida-store::backend::open` routes by prefix (paths starting with `/` go to `LocalFileSystem`).

`dataset_id_for_url(url)` is a blake3 of the URL string — content-derived from the *string*, not the bytes. So:

- For the **sender on their own server**: the same path resolves to the same file, the same `DatasetId` is computed, and refresh-preserves-state works exactly as for cloud-addressable datasets. The URL is a perfectly serviceable personal bookmark.
- For a **recipient on a different server**: the path may not exist, may be outside the recipient's `data_dir` and rejected, or — worst case — may exist but resolve to a *different* file with the same path on a different machine. The `DatasetId` will collide despite the content differing, silently loading the wrong dataset and applying viewport state that was meaningful for the original.

The blake3-collision-on-different-content case is the sharpest edge. Any tooling that treats `DatasetId` equality as content equality has a bug latent in it; saved views with local files are the path that surfaces it.

Three approaches were considered:

1. **Refuse to encode local-file URLs in saved views.** Hostile to local development — local-file workflows would lose refresh-preserves-state entirely.
2. **Warn and embed (chosen).** Honest. Zero infra. Sender keeps refresh-preserves; sharing is documented as fragile. Recipient sees clean error per [URL-as-App-State for Saved Views](0013-url-as-app-state-for-saved-views.md) §"Decision B" (partial-apply with inline warnings) when a path doesn't resolve.
3. **Convert local to served-URL on share.** Server starts exposing the local file via stable HTTP (e.g. `/served/<blake3>`). Recipient web client fetches via HTTP. Big new server responsibility (TLS, auth, content addressing, GC). A real product feature in its own right and out of scope here.

## Consequences

- The web client uses `hasLocalFilePaths(view)`/`localFilePathCount(view)` (in `ShareToolbarButton.tsx`), backed by the canonical `is_local_dataset_url`/`normalize_dataset_url` classifier, at share time — used to surface the warning (and the path count), not to gate the action. (This replaced the original naive `startsWith('/')` check, per the 2026-05-26 amendment above.)
- Recipients receive `OpenDatasetFailed` for any local-file path that doesn't resolve, handled by the existing partial-apply policy (skip-and-continue with inline indicator).
- The blake3-collision sharp edge becomes a documented characteristic of `DatasetId` rather than an unstated assumption. Any future feature that *would* rely on `DatasetId` ↔ content-bytes equality (proxy validation across servers, cross-server cache sharing, etc.) needs an explicit content-derived ID — out of scope here, but recorded for future ADRs.

## Alternatives considered

See "Why" §3 above.

## Related

- [URL-as-App-State for Saved Views](0013-url-as-app-state-for-saved-views.md) — the umbrella saved-views decision; this one carves out a sharp edge in it
- lucida-store — `backend::open` URL-scheme routing
- lucida-server — `dataset_id_for_url` and the `/api/browse` endpoint
