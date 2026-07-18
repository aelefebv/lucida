---
type: Gotcha
title: "Saved-View URLs Expose Dataset URLs (and Anything in Them)"
description: "Saved-view URLs (#view=…) embed dataset URLs verbatim inside the encoded payload."
tags: [lucida, gotcha]
source_path: wiki/gotchas/saved-view-credentials-in-urls.md
created: 2026-05-08
modified: 2026-07-16
---

# Saved-View URLs Expose Dataset URLs (and Anything in Them)

## The footgun

Saved-view URLs (`#view=…`) embed dataset URLs verbatim inside the encoded payload. Anything baked into the URL string is exposed to anyone who sees the link:

- **Presigned URLs** (S3, GCS) carry a signature in the query string. A `#view=…` containing a presigned URL grants the recipient time-bounded access to that bucket object — even if the recipient was never authenticated to the underlying storage.
- **Bearer tokens, API keys, basic-auth credentials** in URL queries or fragments leak the same way.
- **Private bucket paths** that name internal projects/customers leak structure even if the URLs themselves aren't directly accessible to the recipient.

The exposure surface is broader than just "the recipient":

- Clipboard managers retain URL history.
- Browser history persists it.
- Screenshots and screen-shares leak it.
- Slack/email/etc. retain shared links indefinitely (often searchable).
- `#b=<id>` URLs avoid the exposure (the dataset URLs live server-side); the inline `#view=…` form does not.

## Why it works this way

Saved views are designed for refresh-preserves-state and one-shot sharing without server involvement (see [URL-as-App-State for Saved Views](../decisions/0013-url-as-app-state-for-saved-views.md)). The encoder is pure and stateless; it has no way to know which URLs contain credentials and no policy to apply if it did. Filtering would either:

- Reject URLs with query strings (breaks presigned cloud datasets entirely), or
- Strip query strings (breaks the link silently, recipient sees `OpenDatasetFailed`), or
- Refuse to encode any non-`https://` non-bare-path URL (over-broad).

None of these is good. The current contract: the encoder embeds whatever URL the dataset was opened with; the *user* decides whether the resulting link is shareable.

## What's mitigated

- **Local-file paths** (`/data/...` or `file://...`) get an explicit warning in the share toast — a different sharp edge (see [Non-canonical axes are pinned to index 0](non-canonical-axes.md) adjacency: the `DatasetId`-collision problem in [Local-File Datasets Are Personal-Only in Saved Views](../decisions/0014-local-file-datasets-personal-only-in-saved-views.md)).
- **Soft 4 KB threshold** warning hints at "large link, may not survive chat apps" — orthogonal to the credential leak but secondary nudge to consider `#b=<id>` instead.
- **`#b=<id>` URLs** are tiny opaque strings; dataset URLs live in the workspace
  saved-view row. Sharing the link does NOT expose dataset URLs to someone who
  can only see the URL. Fetching the row still requires access to the workspace
  at `/api/workspaces/:workspace_id/saved-views/:id`.

## What's NOT mitigated

- The share toast shows link size and local-file warnings but does NOT inspect URL contents for credential-shaped queries (e.g. `?X-Amz-Signature=…`, `?token=…`, `?api_key=…`). Adding a heuristic check is on the table for v2 but not implemented.
- Once a presigned URL is in a saved view, refreshing the live URL doesn't refresh the signature. When the signature expires, the link becomes stale and recipients see `OpenDatasetFailed` for that dataset. (Sender's own refresh works until the signature expires too.)

## What to do

1. **For presigned URLs**: prefer a workspace saved view and its compact
   `#b=<id>` link. Better: open the dataset via a non-presigned URL (configure
   long-lived bucket access on the server) before saving.
2. **For credentialed URLs**: don't share `#view=…` outside the trust boundary that's already authorized for the underlying storage.
3. **For internal-path leakage** (e.g. URLs that name customers/projects): same — `#b=<id>` keeps the URL server-side.

## Related

- [Saved Views](../systems/subsystems/saved-views.md) — subsystem overview
- [URL-as-App-State for Saved Views](../decisions/0013-url-as-app-state-for-saved-views.md) — why the URL is the encoded state
- [Local-File Datasets Are Personal-Only in Saved Views](../decisions/0014-local-file-datasets-personal-only-in-saved-views.md) — adjacent footgun for local paths
- [Sunset dispositions for superseded server surfaces](../decisions/0043-superseded-server-surfaces-sunset.md) — why the stable `#b=<id>` syntax now resolves a workspace saved view
