---
type: Topic
title: "Topic: Collaboration"
description: "Multi-client coordination — what gets shared, what stays local, how clients learn about each other, and how follow chains propagate state."
tags: [lucida, topic]
source_path: wiki/topics/collaboration.md
created: 2026-05-07
modified: 2026-07-17
---

# Topic: Collaboration

Multi-client coordination — what gets shared, what stays local, how clients learn about each other, and how follow chains propagate state. The central architectural choice is the **document-vs-viewport split**: shared/sequenced state goes through one path, ephemeral per-client state goes through another.

This page is a curated index. Articles live in their canonical homes; follow the links for the content.

## Start here

- [Workspaces](../systems/subsystems/workspaces.md) — the per-workspace container of collaboration: presence, follow, the sequenced document, and the broadcast channel are all workspace-local (no global shared session)
- [Document vs Viewport Command Split](../decisions/0001-document-vs-viewport-split.md) — the foundational split that everything else in collaboration is downstream of
- [Presence and Follow Mode](../systems/subsystems/presence-and-follow-mode.md) — peer-to-peer presence model, transitive follow chains, throttling
- [Saved Views](../systems/subsystems/saved-views.md) — discrete-snapshot counterpart to live follow: `#view=…` URL hashes plus workspace-scoped `#b=<id>` saved views, surfaced through `WorkspaceSavedViewsSidebar`
- [Annotations, comments, and mentions](../systems/subsystems/annotations.md) — point/line/box pins with per-pin comment threads and inline `@mention`s, shared through the sequenced document like any other collaborative state; overlays in 2D and 3D, a mentions inbox, and captured author views

## Crate ownership

- [lucida-server](../systems/crates/lucida-server.md) — Tokio + Axum WebSocket relay; sequences document commands, brokers presence, fans out follow chains
- [lucida-cli](../systems/crates/lucida-cli.md) — terminal client for `lucida-server`; useful for scripted multi-client scenarios

## Why decisions were made

- [Document vs Viewport Command Split](../decisions/0001-document-vs-viewport-split.md) — disjoint `DocumentCommand` / `ViewportCommand` enums separate shared/sequenced from local/ephemeral
- [Peer-to-Peer Follow Mode](../decisions/0002-peer-to-peer-follow-mode.md) — anyone can follow anyone; server validates and flattens chains into stars
- [URL-as-App-State for Saved Views](../decisions/0013-url-as-app-state-for-saved-views.md) — saved views are debounced URL-hash writes (Google-Maps-style); refresh preserves view; sharing = copy URL
- [Local-File Datasets Are Personal-Only in Saved Views](../decisions/0014-local-file-datasets-personal-only-in-saved-views.md) — local-file paths in saved views work for sender refresh but warn on share
- [Server-Stored Bookmarks and the AuthPrincipal Seam](../decisions/0015-server-stored-bookmarks-and-auth-seam.md) — historical predecessor of workspace saved views; the `AuthPrincipal` seam survives

## Cross-cutting flows

- [Flow: Document Command Application](../flows/document-command-application.md) — client → server `seq` assignment → broadcast (with `Ack` to sender) → WASM `apply_command` on every client; includes the loss-recovery path (seq-gap detection → `RequestSnapshot` / server-pushed snapshot on broadcast overflow)
- [Flow: Presence Propagation](../flows/presence-propagation.md) — local viewport change → throttled wire emit → server fan-out (self-filtered) → peer apply (or follow-mirror)
- [Flow: Follow Chain Resolution](../flows/follow-chain-resolution.md) — `set_follow` validation, transitive flatten into stars, disconnect-driven reset
- [Flow: Saved-View Recipient Apply](../flows/saved-view-recipient-apply.md) — `#view=…` or `#b=<id>` → bootstrap parse → diff datasets → open missing → apply layouts/settings/camera in fixed order

## Gotchas

- [Document vs Viewport Command Classification](../gotchas/document-vs-viewport-classification.md) — misclassifying a command floods peers (viewport-as-document) or silently desyncs (document-as-viewport). Most common collaboration footgun.
- [Saved-View URLs Expose Dataset URLs (and Anything in Them)](../gotchas/saved-view-credentials-in-urls.md) — `#view=…` URLs embed dataset URLs verbatim; presigned URLs and credentialed URLs leak via clipboard, history, screenshots
- [Axum's Default Query Extractor Drops Repeated Keys](../gotchas/axum-query-multivalue.md) — historical bookmark-list parser lesson retained for any future repeated-query surface
- [SavedView Mirrors WASM Presence — Client-Only State Won't Round-Trip Without a Dedicated Field](../gotchas/saved-view-client-only-state.md) — `SavedView.dataset_settings` mirrors WASM presence; client-only JS/localStorage state won't round-trip without a dedicated field
- [Scene/DocumentState JSON Backward Compatibility](../gotchas/scene-document-state-json-compat.md) — `Scene` `#[serde(flatten)]`s `DocumentState`; field collisions across the two corrupt the wire format
