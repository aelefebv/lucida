---
created: 2026-05-07
modified: 2026-05-08
---

# Server-Stored Bookmarks and the AuthPrincipal Seam

> Status: Accepted (implemented in PRs #479, #480, #481 — landed 2026-05-08). Auth seam realized via the existing `SessionCookieExtractor` rather than the originally-sketched `StubPrincipalExtractor` (auth landed first, so the stub was never wired).

## Decision

Two coupled architectural shifts to support named, persistent saved views ([[decisions/0013-url-as-app-state-for-saved-views]]):

1. **`lucida-server` gains its first persistent state.** A SQLite-backed bookmark store ([[lucida-server]]'s session has been entirely in-memory until now). Bookmarks are uniquely-identified records (`{id, name, created_by, created_by_name, created_at, datasets, view}`) addressable via short URLs (`#b=<id>`).

2. **An `AuthPrincipal` abstraction is introduced** as the seam between request-handling code and authentication. Saved-views handlers consume a principal (`{email, display_name, picture_url, is_admin}`) from middleware; they never see JWTs, OAuth flows, or any auth provider details. Two extractor implementations: a `StubPrincipalExtractor` for dev (returns `dev@local`) and a `GoogleJwtPrincipalExtractor` (built separately as part of the auth project).

The bookmark feature uses the principal for ownership (`created_by = principal.email`), permission checks (PATCH/DELETE require `bookmark.created_by == principal.email || principal.is_admin`), and UI display (filter by creator, "Mine only" toggle).

## Why

### Why server-stored bookmarks

A pure URL-hash approach ([[decisions/0013-url-as-app-state-for-saved-views]] alone) handles the *personal* use case (refresh-preserves-state) and the *one-shot share* case (copy-current-URL). It does not handle:

- **Discoverability.** "Show me other people's analyses of this dataset" is a sidebar feature; URL hashes are invisible until shared.
- **Persistence with names.** A URL hash carries no name, no creator, no created-at; it's an opaque blob. For curated analyses ("Apoptotic morphology — well B7"), a named entry is qualitatively different.
- **Mutation.** A URL is immutable once shared; a bookmark can be renamed or deleted as understanding evolves.

Server-stored bookmarks fill those gaps without disturbing the URL-hash side. Both surfaces share the same underlying capture record (`SavedView`). Sharing is now bimodal: copy-the-live-URL for ephemeral, or copy-the-bookmark-link (`#b=<id>`) for stable.

The cost is real: `lucida-server` was deliberately stateless outside session memory, and breaking that property is hard to reverse. Considered:
- **Don't add bookmarks; live with URL-only sharing.** Loses discoverability and curation, which are the highest-value features for the Calico use case.
- **Bookmarks live in browser localStorage only (per-user).** Doesn't enable cross-user discovery; loses the "see what others saved for this dataset" feature.
- **Bookmarks live in a third-party store (Notion-like).** Adds an external dependency and a federation boundary; awful for a research-tool deployment.

Server-stored is the only path that delivers cross-user discovery and durable ownership. Accept the persistent-state cost.

### Why SQLite

- **Embedded, single file.** Matches the deployment model (`lucida-server` runs as one process); no separate database server to operate.
- **Mature.** No surprises; everyone knows it; rich tooling.
- **JSON1 extension** supports the indexed any-overlap query ("bookmarks where any of `bookmark.datasets` matches a passed-in URL") without requiring a separate side table or full-table scan.
- **Migrations are just SQL** — no special framework needed.
- **Survives restarts** by default — matches the requirement that bookmarks persist beyond server lifetime.

Considered:
- **`sled`** — KV-only; relational queries (any-overlap, filter-by-creator) would require building secondary indexes by hand. More complexity for the use case.
- **Postgres** — overkill for the deployment scale; adds operational burden.
- **In-memory + JSON-on-disk snapshots** — write fragility, no real query language, hard to evolve schema. Anti-pattern for anything beyond the trivial.

### Why an AuthPrincipal seam

Without a seam, every saved-views handler would need to know how to validate Google JWTs (or whatever provider). That couples the feature to the provider, makes testing painful (need to mint test tokens), and turns the eventual auth-provider migration into a wide-radius change.

With a seam:
- Saved-views handlers depend on a small, stable trait surface (`PrincipalExtractor::extract → AuthPrincipal`).
- The auth project owns the extractor implementation; saved-views never imports anything from the auth provider's SDK.
- Tests substitute a fake extractor trivially.
- Switching auth providers (or adding a second one) is a single-point change.

The trait is also the natural carrier for evolving capabilities: today `is_admin` is plumbed but unused; later, role membership or scoped permissions can extend the principal without disturbing handler code.

## Alternatives considered

- **No `AuthPrincipal` abstraction; handlers directly consume Google identity.** Rejected — couples saved-views to auth provider, hostile to testing, makes provider migration painful.
- **`AuthPrincipal` as a Rust struct in `auth/types.rs` with no extractor trait.** Rejected — leaves "where does the principal come from" ambiguous; hard to test without the real auth flow.
- **Bookmarks scoped per-session rather than globally.** Rejected — would require sessions to become persistent (today they're transient). Globally-scoped bookmarks attached to dataset URLs (which are stable) is the simpler model.

## Consequences

- **`lucida-server` deployment now has a writable directory** for the SQLite file. Operational characteristics change (backup considerations, file ownership).
- **First migration system in the codebase.** Plumbing is small (versioned `.sql` files run on startup) but it's a new operational concept.
- **REST endpoints expand the server's HTTP surface** beyond the existing `/api/browse` admin endpoint. Authentication middleware applies to the new `/api/bookmarks/*` endpoints.
- **WebSocket protocol gains a new server message** (`BookmarkChanged { id, action, dataset_urls }`) for live sidebar updates. Broadcast scope: clients with overlapping loaded datasets.
- **Pre-auth bookmarks** carry `created_by: "dev@local"`. Migration policy on auth cutover is open ([[queue]]).
- **The blake3-collision-on-different-content sharp edge** (see [[decisions/0014-local-file-datasets-personal-only-in-saved-views]]) extends to bookmarks: a bookmark referencing a local-file path will silently load *whatever* file is at that path on the recipient's server. Same warning applies; same documentation.

## How this decision shows up in code

- `lucida-server/src/bookmarks/store.rs` — `BookmarkStore` trait + `SqliteBookmarkStore` + `MemoryBookmarkStore`. Two-table schema (`bookmarks` for the row + `bookmark_datasets` indexed for any-overlap query). Picked side-table over JSON1 to work on every SQLite build and make `EXPLAIN QUERY PLAN` regression-guardable. `delete` returns `Result<Option<Bookmark>, _>` so the broadcast helper can scope by the deleted row's `dataset_urls`.
- `lucida-server/src/bookmarks/handlers.rs` — REST handlers under `/api/bookmarks`. POST overwrites `created_by` from `AuthPrincipal` (request body cannot spoof). PATCH/DELETE check `bookmark.created_by == principal.email || principal.is_admin`. Hand-rolled `parse_dataset_params` against `RawQuery` for repeated `?dataset=…` (Axum's default `Query<T>` drops repeats; see [[gotchas/axum-query-multivalue]]).
- `lucida-server/src/bookmarks/broadcast.rs` — best-effort affected-client computation + dispatch. Empty `dataset_urls` falls through as broadcast-to-all.
- `lucida-server/migrations/20260508000003_create_bookmarks.sql` — versioned migration; runs on startup via the existing sqlx pipeline that auth set up.
- `lucida-core/src/auth_principal.rs` — `AuthPrincipal` struct (shared seam type). Lives in `lucida-core` so future provider extractors don't pull in lucida-server.
- `lucida-server/src/auth/principal.rs` — `PrincipalExtractor` trait + `SessionCookieExtractor` (production path; cookie-based, not pure-JWT) + `GoogleJwtPrincipalExtractor` (Bearer-JWT for future CLI/server-to-server flows). The originally-sketched `StubPrincipalExtractor` was never built — auth landed first so bookmarks consume the real extractor directly.
- `lucida-core/src/saved_view.rs` — the `SavedView` schema, shared between web and server.
- `lucida-core/src/protocol.rs` — `ServerMessage::BookmarkChanged { id, action, dataset_urls }` variant + `BookmarkAction` enum. **First `ServerMessage` variant without a `seq`** — session-scoped notification, not a sequenced document command. See [[saved-views]] §"BookmarkChanged is unsequenced."

## Related

- [[decisions/0013-url-as-app-state-for-saved-views]] — the umbrella saved-views decision; this one extends it with the server-stored side
- [[decisions/0014-local-file-datasets-personal-only-in-saved-views]] — sharp edge that extends to bookmarks
- [[lucida-server]] — gains its first persistent state
- [[presence-and-follow-mode]] — the discrete-snapshot counterpart to live follow
- [[queue]] — auth-cutover migration question; selected-dataset wrinkle
