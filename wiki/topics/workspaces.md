---
type: Topic
title: "Topic: Workspaces"
description: "The durable, server-stored container users return to: a set of opened datasets, a set of saved views, and a membership/access policy, addressed by an opaque id at /ws/workspaces/:id."
tags: [lucida, topic]
source_path: wiki/topics/workspaces.md
created: 2026-06-25
modified: 2026-06-25
---

# Topic: Workspaces

The durable, server-stored container users return to: a set of opened datasets, a set of saved views, and a membership/access policy, addressed by an opaque id at `/ws/workspaces/:id`. This hub is about the **container** — how a workspace is created, who can see and edit it, how datasets live inside it, and how it is shared and duplicated. The *live* collaboration that attaches to a workspace while users are active (presence, follow, the sequenced document) is its own concern — see [Related](#related) and the collaboration topic — so the two hubs don't double-own it.

This page is a curated index. Articles live in their canonical homes (`systems/`, `decisions/`, `gotchas/`); follow the links for the content.

## Start here

- [Workspaces](../systems/subsystems/workspaces.md) — the container model: the two dataset identities (`dataset_source` vs `workspace_dataset`), roles, sharing, create-from-dataset, duplicate, and the never-leak access discipline

## Membership and identity

- [Authentication](../systems/subsystems/auth.md) — membership and link grants resolve through the same `AuthPrincipal` boundary; email is the v0 membership key, and members can be pre-provisioned before they ever sign in
- [Discriminated Active-Set and Entity Types](../decisions/0026-discriminated-active-set-and-entity-types.md) — the discriminated active-set / entity-type model the workspace document is built on

## Saved views inside a workspace

- [Saved Views](../systems/subsystems/saved-views.md) — workspace saved views are the third saved-view surface (they replaced the global bookmark concept once workspaces landed); editors create/update/delete and set the default, viewers list/open/copy
- [URL-as-App-State for Saved Views](../decisions/0013-url-as-app-state-for-saved-views.md) — saved views as debounced URL-hash state; sharing is copy-a-link
- [Local-File Datasets Are Personal-Only in Saved Views](../decisions/0014-local-file-datasets-personal-only-in-saved-views.md) — local-file paths work for the sender but warn on share
- [Server-Stored Bookmarks and the AuthPrincipal Seam](../decisions/0015-server-stored-bookmarks-and-auth-seam.md) — server-stored views behind the `AuthPrincipal` seam

## Gotchas and invariants

- [SavedView Mirrors WASM Presence — Client-Only State Won't Round-Trip Without a Dedicated Field](../gotchas/saved-view-client-only-state.md) — `SavedView` mirrors WASM presence; client-only state needs a dedicated field or it won't round-trip
- **Validate the `wds-` id belongs to the current workspace** — every operation routes `workspace_dataset` → `dataset_source` server-side, but must re-check membership; see [Workspaces](../systems/subsystems/workspaces.md)
- **Duplicate does not inherit members or sharing** — a copied workspace is owner-only with link off, and saved-view payloads are re-stripped of source URLs; see [Workspaces](../systems/subsystems/workspaces.md)

## Related

- [Presence and Follow Mode](../systems/subsystems/presence-and-follow-mode.md) — the live session is per-workspace (each `LiveWorkspace` owns its `Session`, broadcast channel, peer map, and `seq`); the live-collaboration story lives under the collaboration topic, not here
- [lucida-server](../systems/crates/lucida-server.md) — `workspace.rs` hosts the `WorkspaceManager` (live orchestration + authorization + document flow) and the `WorkspaceStore`
- [lucida-cli](../systems/crates/lucida-cli.md) — `workspace`, `share`, and `member` commands drive membership and sharing from the terminal
