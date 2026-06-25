# Flows audit + proposed new flows — 2026-06-25

Audit of `/Users/austin/code/lucida/wiki/flows/` against current source (ground truth). Verdicts cite `file:line`/symbol. The wiki is READ-ONLY here — this document records what to fix, it does not edit the articles.

---

## 1. Existing flows

There are 9 flow articles (excluding `index.md`). Verdicts:

| Flow | Verdict | Issue | Fix |
|---|---|---|---|
| `auth-signin.md` | **HOLDS** | — | None. Full trace verified end to end (see notes). |
| `document-command-application.md` | **INACCURATE** | Central sender-side model is the *opposite* of the code: article says "do not apply locally, wait for `Ack`, one round-trip of latency"; code does optimistic local apply with a no-op `Ack`. | Rewrite the sender-side model (details below). |
| `chunk-lifecycle.md` | **HOLDS** (minor nit) | One step misattributes composite-key routing to `bridge.ts::handleBinary`; minimap-lane priority note. | Re-attribute one step; clarify the lane the priority formula applies to. |
| `dataset-opening.md` | **HOLDS** (2 imprecisions) | Step 4 overstates per-channel visibility calls; step 6 folds a separate async handler into `setupFetchPipeline`. | Tighten two step descriptions. |
| `dataset-diagnostics.md` | **HOLDS** | — | None. Stages/failure kinds/CLI+Py surfaces/fixtures all match. |
| `follow-chain-resolution.md` | **HOLDS** | — | None. All four cases + steer + disconnect verified. |
| `presence-propagation.md` | **HOLDS** | — | None. Throttles, self-filter, follower re-emit verified. |
| `proxy-generation.md` | **HOLDS** (minor) | Prose implies the binding lookup is inside `serve_asset_request`; it is at the call site. Correctly flagged Historical/legacy. | One-line prose fix. |
| `saved-view-recipient-apply.md` | **HOLDS** (1 stale claim) | "Out-of-range t/c/z clamp **silently**" is no longer true; a non-blocking "adjusted to fit" notice is emitted. Also silent on several expansions (not contradictions). | Drop the "silent" claim; optionally note the expansions. |

**Summary: 8 of 9 hold** (several with minor imprecisions). `document-command-application.md` is the one materially wrong article.

### Per-flow evidence

**1. `auth-signin.md` — HOLDS.** Traced against `lucida-server/src/auth/{handlers,middleware,unauth_landing,google_oauth,pending_auth,cookie,config}.rs`.
- Middleware HTML/JSON branching + `accepts_html` (`middleware.rs:99-140`); JS shim `window.location.replace("/auth/start?path=…&hash=…")` (`unauth_landing.rs:43-58`).
- `/auth/start`: 256-bit state, `pending_auth.insert`, `prompt=select_account` only with marker, marker NOT cleared in start (`handlers.rs:777-827`).
- `/auth/callback`: `consume` (single-use), code exchange, JWKS/JWT validate, `email_verified`/`hd` rejection with exact log events, dual Set-Cookie (session + clearing marker) (`handlers.rs:856-1004`).
- Scope `openid email profile`, RS256, no `access_type=offline` (`google_oauth.rs:196-214`).
- Logout: 3 Set-Cookie (clear session + marker + dev-principal) + 302 `/` (`handlers.rs:662-726`).
- Defaults: 7-day idle, 30-day hard cap, SameSite=Lax, HttpOnly, auto-Secure, marker Max-Age=600 (`config.rs:28-36`, `cookie.rs`).
- Failure-table log events all exist (JWKS-fetch mapped to `auth.signin.error.network`, `handlers.rs:909-916`).

**2. `document-command-application.md` — INACCURATE.** The article's core thesis contradicts the code:
- `applyAndSend.ts::applyDocumentCommand` (lines 10-13) calls `scene.apply_command(json)` **locally and immediately**, then `sendCommand(json)`. Optimistic local apply.
- `onAck` is a **no-op**: `useBridge.ts:360` `onAck: (_seq) => {}`.
- `SliceViewer.tsx:234-237` makes it explicit: apply locally AND send; "the sender is excluded from the server's rebroadcast… The client-supplied id makes the local apply and peers' broadcast converge."
- Wrong sections: step 3 ("Do not apply locally yet"), step 6 (sender "applies the command locally now" upon `Ack`), the entire "Why round-trip on the sender" section, the invariant "Sender does not apply locally before sending," and the gotcha "Latency is one full round-trip."
- Server side is **correct**: `handler.rs:473-502` `apply`→`seq`, `CommandBroadcast` for all-except-sender + `Ack` for sender; broadcast loop `:341-347`; `seq` ring at 256 (`session.rs:15,80-85`). The `DatasetOpened` sentinel `u64::MAX` special case (`:1711-1712`, `:2190-2215`) is correct.
- **Fix:** the convergence mechanism is **client-supplied stable IDs + optimistic local apply**, not server-ordered Ack-then-apply. Rewrite the sender-side trace, drop the latency gotcha, and replace the "sender does not apply locally" invariant with the real one (sender applies locally and is excluded from rebroadcast; IDs make local + peer state converge).

**3. `chunk-lifecycle.md` — HOLDS (minor nit).**
- Priority formula `laneOffset + (1-importance)*500 + distance*10` exact: `emit.ts:34-38`; `IMPORTANCE_WEIGHT=500` (`config.ts:65`), `DISTANCE_WEIGHT=10` (`config.ts:68`).
- `FETCH_CONCURRENCY_MULTIPLIER = 3` + 32 MB in-flight: `cpuCache.ts:77-78,176`. Decode pool `Math.max(2, floor(cores/2)-1)`: `decodePool.ts:10-15`.
- Upload budgets 8 MB main (`upload/constants.ts:7`), 2 MB minimap (`renderLoopTypes.ts:51`).
- Chunk frame `[client_id u32 LE][key_len u16 LE][key][payload]`: `bridge.ts:390-398`; composite key `{datasetId}/{imageId}/{chunkKey}` + `proxy/` routing: `contentSource.ts:97-113`.
- **Nit:** the article credits `bridge.ts::handleBinary` with composite-key routing, but that fn only splits the frame and forwards `(key,payload)`; the composite-key dispatch lives in `contentSource.handleBinary`. Also the minimap lane uses bare `laneOffset` (no importance/distance, `emit.ts:44-47`) — the formula applies to the detail lane.

**4. `dataset-opening.md` — HOLDS (2 imprecisions).**
- Server `handle_open_remote_dataset`: normalize, `dataset_id_for_url` BLAKE3 `ds-{016x}` (`lucida-content/src/url.rs:129-132`), separate `new_workspace_dataset_id`, dedup short-circuit rebroadcasts existing `DatasetOpened` with sentinel `u64::MAX` (`handler.rs:1466-1733`).
- WASM hand-off: `command.rs:418-458` `DatasetOpened` arm builds derived state via `register_dataset`, inits `dataset_settings` per channel via `.entry().or_insert_with()` (preserves user settings on reopen — idempotency correct), bumps `epochs.content` (`:457`) + `epochs.layout` (`:458`).
- **Imprecision 1:** step 4 ("`set_channel_visible` per channel") — code only touches the *last* channel *once* when `channelCount>1` to grow the vec (`useBridge.ts:618-630`), not per-channel.
- **Imprecision 2:** step 6 (generated-availability merge) is a separate async handler, not one of `setupFetchPipeline`'s six steps (`useBridge.ts:554-659`).

**5. `dataset-diagnostics.md` — HOLDS.**
- 10 open stages match (`lucida-protocol/src/diagnostics.rs:12-23` `DatasetOpenStage`).
- Failure categories present in `DatasetOpenFailureKind` (`:27-45`); health healthy/degraded/unavailable (`:81-85`).
- CLI `dataset open/health/retry` + top-level `--json` (`lucida-cli/src/main.rs:101,512-557`; `dataset.rs:211,306,340`). Python `workspace.datasets.open/health/retry` + `LucidaError.diagnostic`/`.to_dict()` (`lucida-py/python/lucida/client.py:23-50,461,523,580,620`).
- Smoke script + fixtures exact (cppx_plate, yeast_3d, lif_bundled_channels, czi_noncanonical_axes) + negative cases (`scripts/smoke_dataset_reliability.py:32-59,302-318`). `--generated-coarse-enabled` (`main.rs:75`); Debug>Health tab (`debug/DebugPanel.tsx:60`).

**6. `follow-chain-resolution.md` — HOLDS.** Four cases + steer verified against `session.rs::set_follow` (`:219-268`), `remove_client` (`:171-182`), and `handler.rs` Follow/Steer/disconnect broadcasts (`:543-573`, `:932-952`): self-follow rejected (`:227-229`); follow-someone-following rejected (`:234-237`); transitive flatten (`:251-265`); disconnect clears followers (`:175-181`). Steer = `set_follow(client, Some(sender_id))` (`handler.rs:561`). Tests `session.rs:517-560`.

**7. `presence-propagation.md` — HOLDS.** `applyViewportCommand` only calls `apply_command` (`applyAndSend.ts:17-23`). Throttles: presence ~50 ms (`bridge.ts:471`), cursor ~50 ms with null immediate (`:550,562`), dataset_presence ~200 ms (`:489`). Server self-filter `sender == id` (`handler.rs:348-365`); following clients re-emit via `sendPresence(export_presence())` (`useBridge.ts:395-398,433-436`).

**8. `proxy-generation.md` — HOLDS (minor; correctly flagged Historical).** Module intact: `lucida-server/src/proxy/{generator,cache,server_source,mod}.rs`. In-flight dedup keyed by `ProxySpec` (`generator.rs:79`); bounded semaphore default `(num_cpus::get()/2).max(1)` (`lib.rs:120-121`). `serve_asset_request` builds `ProxySpec{…, target_long_axis: PROXY_TARGET_LONG_AXIS=128}`, `generator.request(spec, 1)`, encode, unicast (`handler.rs:2603-2648`, `:2295`). Frame `[client_id u32][key_len u16][key][header 64][voxels u16]` (`:2653+`); wire `proxy_kind_str` pins `WellProxy3D`/`FieldProxy3D` (`:2699`, test `:3000-3001`). Cache validation by `algorithm_version` + `source_content_hash` (`cache.rs:141`); disk path `field3d`/`well3d` (`cache.rs:264-265`). **Minor:** `serve_asset_request` receives `&Arc<ProxyGenerator>` directly; the binding lookup is at the call site (`handler.rs:883`), not inside the fn.

**9. `saved-view-recipient-apply.md` — HOLDS (1 stale claim).** Apply order in `applier.ts::apply` (`:264-445`) matches steps 5→10; `applyInProgress` guard, `emitApplyResult`/`firstVisible` (`:450-482`); `subscribeApplyComplete` wiring in `useSavedViewSync.ts:340-368` exact. urlSync: `parseViewHash`/`parseBookmarkHash` (`[A-Za-z0-9._-]+`), bootstrap via applier, popstate re-bootstrap, `#b=`→`#view=` collapse (`urlSync.ts:157-212,389-402,123-131,184-188`). Decoder rejects `v` missing/zero, best-effort + warn for `v>version` (`encoder.ts:9,74-83`).
- **Stale detail:** the article says out-of-range t/c/z "clamp **silently**"; code now emits a non-blocking "adjusted to fit" notice via `clampNotice`/`addWarning` (`applier.ts:411-417, 840-845`).
- **Silent on expansions** (not contradictions): a second `workspace-dataset-id` reference mode + `allowDocumentLayoutMutation` (`applier.ts:162-163,179-180,304-306,352-357`); `#a=` annotation deep-links, `?viewer_profile=`, default-view and per-user last-view resolution (`urlSync.ts:168,192-259,412-431`).

---

## 2. Proposed new flows

Each is grounded in `file:line`/symbol evidence below and avoids duplicating the existing 9. Ruled out as already covered: **generated-coarse serve** (`systems/subsystems/generated-coarse.md`), **OAuth core sign-in** (`flows/auth-signin.md`), **workspace create/duplicate/share** (`systems/subsystems/workspaces.md`). A **browser dataset-upload** flow does not exist — datasets open by URL/path, no upload route in `lucida-server`.

### NF-1. Annotation create → capture → restore-author-view → deep-link  — *highest value*

**Trigger → outcome:** A user shift-drags a point/line/box pin on a dataset → the pin (with the author's exact view snapshot) broadcasts to all peers and persists → later, anyone clicks "Go to author's view" / an @mention / opens a `#a=<id>` share link → their viewport reproduces the author's camera (incl. 2D↔3D mode flip), z/t/c, and per-channel display.

**Key files:**
- Capture: `lucida-web/src/savedView/buildAnnotationView.ts` (workspace-dataset-id mode, no source URLs; `liveViewWithLiveZTC`/`liveViewWithLiveTC` for the 2D/3D create paths).
- Command + state: `lucida-core/src/command.rs` (`AddAnnotation`/`AddComment`/`MoveAnnotation`/`EditComment`/`RemoveAnnotation`/`RemoveComment`, all bump `epochs.annotation`); `lucida-core/src/scene/types.rs` (`struct Annotation` carrying `position`+`z`+`t`+`c`+`kind`+`end`+`comments`+`anchor` at `:272`; `AnnotationKind`).
- Light restore: `lucida-web/src/savedView/restoreAnnotationView.ts` (recipient-local ViewportCommands only — deliberately NOT the heavy `applier.ts`; `switchCameraMode`, per-channel display replay, z/t/c clamp to the pin's own dataset; the light/heavy boundary is "enforced HERE, by construction" per the module header).
- Deep-link: `lucida-web/src/savedView/annotationDeepLink.ts`, `lucida-web/src/hooks/useAnnotationDeepLink.ts`, `parseAnnotationHash`/`buildAnnotationHash` in `lucida-web/src/savedView/urlSync.ts:412,435`; `#a=`→`#view=` collapse after restore (`urlSync.ts:288`).
- Author identity: `lucida-web/src/annotationIdentity.ts` (localStorage author id, distinct from per-connection `bridge.myId`).

**Why:** A large, multi-slice subsystem (issues #526, #777, #780, #814, #830) with **no wiki article at all** — not in flows, not in subsystems. It rides the document-command/epoch machinery (ties to `document-command-application`, `scene-state-and-epochs`) but has a non-obvious light/heavy restore split that exists specifically to avoid the destructive cold-share-link applier. The light-vs-heavy boundary and the `#814` clamp-skip regression are exactly the "why" a flow doc should capture.

### NF-2. CLI/agent headless capture (montage + screenshot/overview) via CDP

**Trigger → outcome:** `lucida dataset montage out.png --json` (or `lucida view screenshot/overview`) → CLI plans cells, probes a shared auto-contrast window, drives a headless Chrome over raw CDP against the chrome-free `?render=1` viewer, waits on a render-readiness probe, captures per-cell PNGs, stitches a labeled contact sheet, and writes a sidecar JSON with drill-in URLs.

**Key files:**
- Planning/composition: `lucida-cli/src/montage.rs` (`plan_montage` `:82`, `MontageAxis` `:24`, `build_cell_view` `:179`, `with_render_param` `:326`, `stitch_grid` `:280`).
- Orchestration: `lucida-cli/src/main.rs` — `capture_montage_pngs` (`:3360`), `probe_montage_auto_contrast` (`:3548`), `capture_cdp_png` (`:3685`), `capture_cdp_auto_contrast` (`:3421`), `capture_ready_probe_from_cdp_result` (`:3967`).
- Capture surface: `lucida-web/src/App.tsx` (`?render=1` chrome-free gating), `lucida-web/src/hooks/useLayout.ts`.
- Readiness handshake: `lucida-web/src/renderLoop.ts:253` publishes `window.__lucidaCaptureReady = { … frameCount: this.renderedFrameCount … }` — the exact object the CLI's CDP `Runtime.evaluate` probe reads (`LucidaCaptureReadyState` declared at `renderLoop.ts:24,34`).

**Why:** A genuine cross-surface flow (CLI ↔ headless browser ↔ WebGPU render loop) invisible from any single crate; the CLI article only name-checks it. It relies on a hand-rolled CDP client plus a render-readiness contract (`__lucidaCaptureReady`) that future viewer changes could silently break, and on a shared-vs-per-cell contrast probe — a real, easily-regressed decision.

### NF-3. Layout switch → annotation re-anchor (plate re-layout)

**Trigger → outcome:** An editor switches a plate dataset's active layout (`SetActiveLayout`) → on every client's canonical apply, each glued pin is rigidly translated by the displacement of its anchor entity between the old and new layouts, so pins stay on the data they were dropped on; derived render state rebuilds and `epochs.layout` bumps.

**Key files:**
- `lucida-core/src/scene/types.rs`: `DocumentState::apply(SetActiveLayout)` (`:985`) reads the previous layout id then calls `reanchor_for_layout` (`:905`); `nearest_anchor` (`:853`) glues a pin at creation; `Annotation.anchor: Option<EntityId>` (`:272`).
- `lucida-core/src/command.rs`: `Scene::apply` special-cases `SetActiveLayout` ordering (apply doc state → rebuild derived → bump `epochs.layout`).
- `lucida-core/src/scene/mod.rs`: `resolve_layout` / `resolve_entity_position` / `build_derived_state` (the placed-vs-unplaced entity distinction re-anchor depends on).
- Recipient apply context: `lucida-web/src/savedView/applier.ts` (`SetActiveLayout` is a document command in the shared apply order).

**Why:** The concrete interaction between two separately-documented subsystems (`layout-system`, the undocumented annotations) and the document-command flow. The invariants are subtle and defensive (skip pins unplaced in *either* layout; unanchored pins left alone; runs in the canonical apply path so it persists and reaches every peer identically) — classic flow-doc material, grounded in #780.

### NF-4. Saved-view propose → approve/reject (with deferred Undo)

**Trigger → outcome:** A viewer (no edit rights) proposes their personal saved view → it enters every editor's review queue → an editor approves (→ Shared, visible to all) or rejects (→ reverts to the proposer's Personal, leaves the editor's queue); reject is deferred behind an undoable toast.

**Key files:**
- Server model + queue filtering: `lucida-server/src/workspace.rs` (`SavedViewVisibility::{Shared,Personal,Proposed}` `:92`; the never-leak query surfacing *every* `Proposed` view only to editors, `:524-528`; `set_saved_view_visibility` / approve / reject paths).
- REST: `lucida-web/src/workspaceApi.ts` (`approveWorkspaceSavedView`, `rejectWorkspaceSavedView`, `setWorkspaceSavedViewVisibility`).
- Client orchestration: `lucida-web/src/hooks/useWorkspaceSavedViews.ts` (`approveSavedView`/`rejectSavedView` + optimistic list reconciliation), `lucida-web/src/components/WorkspaceSavedViewsSidebar.tsx` (per-id deferred-reject timer Map + keyed Undo toasts `reject:<id>`; `canProposeToTeam`).
- CLI parity: `lucida-cli/src/saved_view.rs` (`approve`/`reject`/`set_visibility`).

**Why:** The collaboration/permission workflow (#702) that the `saved-views`/`workspaces` subsystem articles only mention in passing. The three-state visibility machine, the editor-only review-queue disclosure (a never-leak boundary), and the deferred-Undo mechanism (per-id timers) are non-obvious and span server + web + CLI.

### NF-5. OAuth JWKS refresh & key rotation  — *or fold into `auth-signin`*

**Trigger → outcome:** An inbound Google-signed JWT must be validated → the server checks its in-memory JWKS cache; on a 24h time trigger or an unknown-`kid` validation failure it refetches Google's key set, then re-validates — so weekly Google key rotation never causes a sustained auth outage.

**Key files:**
- `lucida-server/src/auth/google_oauth.rs` (module header `:12-17` documents the two triggers; `JWKS_REFRESH_INTERVAL` 24h `:49`; time-based refresh `:276-279`; unknown-`kid` on validation failure `:267-274`; `JwksCache` `:147-179`).
- `lucida-server/src/auth/config.rs` (`DEFAULT_GOOGLE_JWKS_URI`, `LUCIDA_GOOGLE_JWKS_URI` override, `jwks_uri`).
- Consumed by `lucida-server/src/auth/handlers.rs::auth_callback` (the `auth.signin.error.jwt_invalid` branch in `flows/auth-signin.md`).

**Why:** `flows/auth-signin.md` treats JWKS as a one-line "cache miss triggers refresh," but the dual-trigger rotation policy is its own durable mechanism with a clear failure-mode rationale (Google rotates ~weekly; unknown-`kid` is the canonical staleness signal). A short focused trace would prevent someone "fixing" the refresh logic without understanding the rotation contract. If a full article feels thin, document it as a sub-section/expansion of `auth-signin`.

---

**Priority:** NF-1 (annotations) is the highest-value gap — a whole subsystem with zero wiki coverage. NF-2 (CLI capture/montage) and NF-3 (layout re-anchor) are next, each a true cross-module flow. NF-4 and NF-5 are smaller but fill real holes in collaboration and auth.
