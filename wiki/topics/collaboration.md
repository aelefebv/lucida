---
created: 2026-05-07
modified: 2026-06-25
---

# Topic: Collaboration

Multi-client coordination — what gets shared, what stays local, how clients learn about each other, and how follow chains propagate state. The central architectural choice is the **document-vs-viewport split**: shared/sequenced state goes through one path, ephemeral per-client state goes through another.

This page is a curated index. Articles live in their canonical homes; follow `[[wiki-links]]` for the content.

## Start here

- [[decisions/0001-document-vs-viewport-split]] — the foundational split that everything else in collaboration is downstream of
- [[presence-and-follow-mode]] — peer-to-peer presence model, transitive follow chains, throttling
- [[saved-views]] — discrete-snapshot counterpart to live follow: `#view=…` URL hashes + server-stored `#b=<id>` bookmarks, surfaced through the `WorkspaceSavedViewsSidebar` component with live cross-peer updates

## Crate ownership

- [[lucida-server]] — Tokio + Axum WebSocket relay; sequences document commands, brokers presence, fans out follow chains
- [[lucida-cli]] — terminal client for `lucida-server`; useful for scripted multi-client scenarios

## Why decisions were made

- [[decisions/0001-document-vs-viewport-split]] — disjoint `DocumentCommand` / `ViewportCommand` enums separate shared/sequenced from local/ephemeral
- [[decisions/0002-peer-to-peer-follow-mode]] — anyone can follow anyone; server validates and flattens chains into stars
- [[decisions/0013-url-as-app-state-for-saved-views]] — saved views are debounced URL-hash writes (Google-Maps-style); refresh preserves view; sharing = copy URL
- [[decisions/0014-local-file-datasets-personal-only-in-saved-views]] — local-file paths in saved views work for sender refresh but warn on share
- [[decisions/0015-server-stored-bookmarks-and-auth-seam]] — SQLite-backed bookmarks with `AuthPrincipal` seam

## Cross-cutting flows

- [[flows/document-command-application]] — client → server `seq` assignment → broadcast (with `Ack` to sender) → WASM `apply_command` on every client
- [[flows/presence-propagation]] — local viewport change → throttled wire emit → server fan-out (self-filtered) → peer apply (or follow-mirror)
- [[flows/follow-chain-resolution]] — `set_follow` validation, transitive flatten into stars, disconnect-driven reset
- [[flows/saved-view-recipient-apply]] — `#view=…` or `#b=<id>` → bootstrap parse → diff datasets → open missing → apply layouts/settings/camera in fixed order

## Gotchas

- [[gotchas/document-vs-viewport-classification]] — misclassifying a command floods peers (viewport-as-document) or silently desyncs (document-as-viewport). Most common collaboration footgun.
- [[gotchas/saved-view-credentials-in-urls]] — `#view=…` URLs embed dataset URLs verbatim; presigned URLs and credentialed URLs leak via clipboard, history, screenshots
- [[gotchas/axum-query-multivalue]] — Axum's default `Query<T>` extractor silently drops repeated query keys; bookmarks list endpoint hand-rolls the multi-value parse
