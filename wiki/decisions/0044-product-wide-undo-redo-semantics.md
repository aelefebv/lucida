---
type: Decision
title: "Product-Wide Undo and Redo Semantics"
description: "Undo follows Lucida's document/viewport boundary: local view history stays local, while shared undo appends authorized inverse document commands."
tags: [lucida, decision]
source_path: wiki/decisions/0044-product-wide-undo-redo-semantics.md
created: 2026-07-16
modified: 2026-07-16
---

# Product-Wide Undo and Redo Semantics

> Status: Accepted as the semantic contract; implementation is incremental.

## Decision

Lucida has two undo systems, matching the existing [document vs viewport command split](0001-document-vs-viewport-split.md). It does not have one process-wide stack and does not use browser history as an undo log.

### Local view history

Viewport navigation, dimension selection, channel/display settings, selection, and other per-client presentation changes use a local, session-scoped history. It belongs to the active viewer, is never broadcast, and is cleared by reload or workspace replacement. A saved-view URL remains a reproducible snapshot of the current view, but its `replaceState` updates do not create undo entries; this preserves the separation established by [URL-as-App-State](0013-url-as-app-state-for-saved-views.md).

Continuous interaction is coalesced at gesture boundaries: one drag, scrub, wheel burst, or contrast adjustment produces one history entry, not one per input event. Opening a saved view or choosing an Explore candidate produces a view-history entry. Explore's existing one-way stack is labelled **Previous view**, because it is contextual navigation rather than the product undo stack.

Local history is bounded and scoped to one workspace/viewer. The first implementation may omit persistence and may expose only undo; when redo lands, any new forward mutation clears the redo branch.

### Shared document history

Dataset open/remove, layout registration or activation, annotations, comments, and other `DocumentCommand` operations are collaborative. Undo never rewinds the workspace sequence and never restores an old snapshot over peers' newer work. Instead, it appends a new, sequenced inverse command to the shared document log. Redo appends the inverse of that inverse.

Every inverse command carries the target operation identity and the revision/precondition it expects. The server rechecks the caller's current authorization, ownership rules, and target revision when undo is requested. If the target changed, was removed, or is no longer authorized, the operation fails visibly and leaves the document unchanged. The client must not claim success or silently manufacture a local result.

Undo is normally limited to operations authored by the current principal. A future elevated moderation capability may undo another author's operation only as an explicit, audited action; it must not be implied by ordinary editor access. Peers see successful inverse commands like any other document change, including authorship and sequence.

Shared commands and their inverses remain in the durable audit/sequence history, but a user's convenient undo/redo stack is not persisted in v1. Reloading reconstructs current document state, not an actionable personal stack. A future server-backed stack must preserve the same authorization and precondition rules.

### Cancelable and irreversible actions

A delayed action canceled before any command is sent is **Cancel**, not Undo. In particular, rejecting a proposed saved view has a short pre-commit window whose action is labelled **Cancel rejection**. No inverse command exists because the rejection has not happened yet.

Operations without a safe inverse remain irreversible until the document protocol can express and authorize one. Permanent deletion of a saved view, deletion of an annotation thread and its comments, and destructive workspace lifecycle actions require confirmation that states **This cannot be undone**. A confirmation delay is not itself an undo system.

### Keyboard and focus rules

The eventual shortcuts are:

- `Cmd+Z` on macOS and `Ctrl+Z` elsewhere: undo in the active viewer scope.
- `Shift+Cmd+Z` on macOS, and `Ctrl+Shift+Z` or `Ctrl+Y` elsewhere: redo.

Lucida handles these only when focus is not in an editable text field, native control, menu, or modal dialog. Native text editing always wins. The shortcut applies to the current workspace and the most recently active applicable stack; it never triggers browser Back and never crosses workspaces. Disabled commands expose why they are unavailable, including a collaboration conflict or permission change.

## Classification

| Operation | Scope | Mechanism | Conflict/authorship |
| --- | --- | --- | --- |
| Pan, zoom, orbit, Z/T/channel/display, selection | Local viewport | Coalesced, bounded session history | No peer conflict; cleared on reload/workspace change |
| Explore candidate / saved-view navigation | Local viewport | View-history entry; Explore exposes **Previous view** | No peer conflict |
| Dataset open/remove and layout changes | Shared document | Append inverse `DocumentCommand` | Current permission + target revision required |
| Annotation and comment create/edit/remove | Shared document | Append inverse `DocumentCommand` where a lossless inverse exists | Current ownership/permission + target revision required |
| Proposal approval/rejection after commit | Shared document | Future inverse command only if the protocol defines one | Authorization and target state checked at request time |
| Deferred proposal rejection before commit | Pending local intent | **Cancel rejection** | Nothing was sequenced, so there is nothing to undo |
| Permanent saved-view/thread/workspace deletion without an inverse | Irreversible | Explicit confirmation | Must say it cannot be undone |

## Why

This keeps local interaction fluid without letting one person's navigation fight another's, while ensuring collaborative recovery is itself visible, ordered, and reproducible. It follows [Collaboration & Reproducibility](../principles/collaboration-and-reproducibility.md): peers must converge on one shared document rather than seeing private rewinds of shared state. It also makes recovery semantics available to non-visual clients; inverse document commands can be driven through the same workspace contract instead of existing only as a web shortcut.

## Consequences

- The command model needs explicit inverse metadata and optimistic preconditions before collaborative undo can ship.
- Some actions remain deliberately non-undoable; the UI must say so rather than suggest a recovery that cannot be guaranteed.
- Local view history can ship independently because it does not change the document protocol.
- Undo/redo controls and telemetry must name their active scope so conflicts are diagnosable for both people and agents.

## Implementation follow-up

- `lucida-87k.2.22` implements the bounded, coalesced local viewport history and focus-safe shortcuts.
- `lucida-87k.2.23` adds revision-checked inverse document commands and collaborative convergence tests.

## Related

- [Document vs Viewport Command Split](0001-document-vs-viewport-split.md)
- [URL-as-App-State for Saved Views](0013-url-as-app-state-for-saved-views.md)
- [Collaboration & Reproducibility](../principles/collaboration-and-reproducibility.md)
