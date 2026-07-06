---
type: Flow
title: "Flow: Saved-View Propose → Review"
description: "How a viewer without edit rights gets a saved view onto the team's shared shelf: they propose it → it enters every editor's review queue → an editor approves (→ Shared, visible to all) or rejects (→ back to the propos…"
tags: [lucida, flow]
source_path: wiki/flows/saved-view-proposal-review.md
created: 2026-06-25
modified: 2026-07-03
---

# Flow: Saved-View Propose → Review

How a viewer without edit rights gets a [saved view](../systems/subsystems/saved-views.md) onto the team's shared shelf: they **propose** it → it enters every editor's review queue → an editor **approves** (→ Shared, visible to all) or **rejects** (→ back to the proposer's Personal). This is the collaboration/permission workflow (#702) the [Saved Views](../systems/subsystems/saved-views.md) and [Workspaces](../systems/subsystems/workspaces.md) articles only mention in passing. It spans server ([lucida-server](../systems/crates/lucida-server.md) `workspace/`), web ([lucida-web](../systems/crates/lucida-web.md) `useWorkspaceSavedViews.ts` + `WorkspaceSavedViewsSidebar.tsx`), and [lucida-cli](../systems/crates/lucida-cli.md) (`saved_view.rs`).

Three things make it non-obvious and worth a trace: a **three-state visibility machine** with a deliberately-closed transition allow-list, an **editor-only review-queue disclosure** that is a never-leak boundary, and a **deferred, per-id-undoable reject**.

## The three states

`SavedViewVisibility` (`workspace/types.rs`), persisted as TEXT and serialized lowercase:

- **Shared** — the collaborative shelf; readable by every member.
- **Personal** — belongs to exactly one member; never disclosed to anyone else, not even owners/admins.
- **Proposed** — a viewer's *bid* to share. Like Personal it belongs to one member, but it is additionally surfaced to **editors** as a review queue.

## Trace: propose

1. **Viewer proposes** — a viewer can create only Personal views, so the "share" affordance instead proposes. `WorkspaceSavedViewsSidebar.tsx::handlePropose` (`:339`) calls `setSavedViewVisibility(id, "proposed")` → `useWorkspaceSavedViews.ts::setSavedViewVisibility` → `workspaceApi.ts::setWorkspaceSavedViewVisibility` (`PATCH …/saved-views/{id}/visibility`). `canProposeToTeam` gates the affordance to the creator's own Personal view.
2. **Server re-scopes via the creator gate** — `set_workspace_saved_view_visibility` routes through `ensure_saved_view_rescopable` (creator-only) and the **transition allow-list** `saved_view_transition_allowed` (`workspace/manager.rs`). `Personal → Proposed` is allowed (the creator proposing their own view); the row flips to `Proposed`.
3. **It appears in editors' queues** — the next `list_saved_views` for any editor now includes it (see disclosure below). The proposer can withdraw at any time: `Proposed → Personal` is also on the allow-list (`handleWithdraw`, gated to the proposer's own proposed view).

## Trace: approve

1. **Editor approves** — `handleApprove` → `approveSavedView(id)` → `approveWorkspaceSavedView` (`POST …/approve`). Approve is **immediate** (only reject is recoverable).
2. **Server authorizes as a reviewer** — `approve_saved_view` (`workspace/manager.rs`) uses `ensure_proposal_reviewable`, NOT the creator gate: `require_editor` → fetch → never-leak guard → must currently be `Proposed`. It then forbids self-approve (`created_by == reviewer` → `Forbidden`) and sets visibility `Shared`.
3. **Client reconciles** — the hook swaps in the server's canonical row immediately, then `refresh()`s. The view is now on the shared shelf and stays visible to the approving editor.

## Trace: reject (deferred, undoable)

1. **Editor rejects** — `handleReject` (`WorkspaceSavedViewsSidebar.tsx:409`) does NOT fire the PATCH. It optimistically hides the row (`pendingReject` set), shows an Undo toast keyed `reject:<id>` (`rejectToastId`), and starts a per-id timer (`rejectTimers` Map, `REJECT_UNDO_WINDOW_MS = 6000`).
2. **Undo (within the window)** — `cancelReject` clears that view's timer, un-hides the row, and dismisses only its toast. No PATCH ever fires — the rejection simply never happened.
3. **Commit (window elapses)** — the timer fires `rejectSavedView(id)` → `rejectWorkspaceSavedView` (`POST …/reject`). `reject_saved_view` (`workspace/manager.rs`) — same reviewer authority as approve — sets visibility back to `Personal`. It is **non-destructive**: the saved camera and attribution are untouched; the proposer just keeps it privately.
4. **Client drops it** — a rejected view reverts to the proposer's Personal, which the reviewing editor can no longer see, so the hook filters it out and `refresh()`s. If the row was the open/active one, `invalidateIfOpen` clears the host highlight (#818).

## CLI parity

`lucida saved-view approve|reject|set-visibility` hit the same endpoints (`saved_view.rs:308`/`:328`/`:284`; `saved_view_approve_url`/`saved_view_reject_url`). The CLI shares the visibility enum (`SavedViewVisibility`, `saved_view.rs:48`) as one source of truth for the `--visibility` flag and the wire tokens. There is no client-side undo on the CLI path — `reject` commits immediately (the deferral is a web-UI affordance, not a server contract).

## Invariants

- **A Proposed view never leaks to non-editors.** `list_saved_views` (`workspace/store/sqlite.rs`) resolves the whole predicate in SQL: every Shared view, the caller's own Personal/Proposed, and — only when `viewer_can_edit` — *every* Proposed view. No other member's Personal or (for a non-editor) Proposed row ever crosses the store boundary. No fetch-all-then-filter.
- **Reviewing cannot probe for hidden personal views.** `ensure_proposal_reviewable` returns `NotFound` (identical to a missing row) for a Personal view that isn't the editor's own, BEFORE the "must be Proposed" check — so an editor can't use approve/reject to confirm another member's private view exists.
- **No self-approve, by two independent gates.** The `/visibility` allow-list forbids `Proposed → Shared` outright (#817 — closes the direct bypass), and `approve_saved_view` additionally forbids `created_by == reviewer`. Sharing a proposal is exclusively the editor review queue's job.
- **Reject is non-destructive.** It only re-scopes Proposed → Personal; the view's `view`, `name`, and `created_by` are preserved.
- **Each pending reject owns its own timer and toast.** `rejectTimers` and the toast stack are keyed by saved-view id, so a power-user can stack several rejects and Undo each independently; rejecting view B never evicts view A's still-live Undo (#818).

## Gotchas

- **Two authority gates that look similar but differ.** Re-scoping (`/visibility`) is **creator-only** (`ensure_saved_view_rescopable`); approve/reject is **editor-over-another-member's-bid** (`ensure_proposal_reviewable`). Routing a review action through the creator gate (or vice-versa) would either block legitimate reviews or open the self-approve bypass. They are deliberately separate functions.
- **Approve is immediate; reject is deferred.** Asymmetric on purpose — an accidental reject is recoverable for 6 s, an approve is not. Don't "simplify" them into one path.
- **The transition allow-list is the structural gate, not the web UI.** `Shared → Proposed` and `Proposed → Shared` are `BadRequest` even if a client sends them directly; the closed allow-list makes the illegal transitions unreachable rather than merely unsent.
- **Same-state visibility PATCH is an idempotent no-op** (`X → X` returns `Ok`), so a benign "set it to what it already is" never errors.

## Related

- [Saved Views](../systems/subsystems/saved-views.md) — the subsystem overview; visibility model and the `SavedView` payload
- [Workspaces](../systems/subsystems/workspaces.md) — membership/roles and the `/api/workspaces/{id}/saved-views` surface
- [Flow: Saved-View Recipient Apply](saved-view-recipient-apply.md) — what happens when someone opens a (now-Shared) view's link
- [lucida-server](../systems/crates/lucida-server.md) — `workspace/` store + authorization gates
- [lucida-cli](../systems/crates/lucida-cli.md) — the `saved-view` command parity
- [Server-Stored Bookmarks and the AuthPrincipal Seam](../decisions/0015-server-stored-bookmarks-and-auth-seam.md) — the server-stored-view + auth-seam rationale this builds on
