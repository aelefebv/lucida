# Lucida Acceptance and Validation Specification

Version: 0.1 (acceptance draft)  
Date: 2026-02-28  
Status: Validation contract for the Lucida product specification

## 1. Purpose

This document defines the acceptance criteria, validation methodology, release gates, and test scenarios for Lucida.

It translates the architectural and protocol specifications into a concrete answer to the question:

**What must be true for Lucida to be considered correct, usable, performant, and releaseable?**

This document is intentionally stricter than a feature checklist. A feature is not "done" merely because it exists. It is accepted only when:
- it behaves according to the protocol and storage contracts,
- it satisfies functional and UX invariants,
- it does not violate generation/consistency guarantees,
- it meets the defined performance envelope for the target test fixtures,
- and it passes the release-blocking scenarios in this document.

This acceptance spec covers:
- engine correctness
- client correctness
- control-plane and data-plane behavior
- generation/change handling
- 2D and 3D viewing
- labels and metadata filtering
- targets, cutouts, and sparse derived-layer publishing
- collaboration, permissions, and audit
- scene/context reproducibility
- performance and robustness under load

This document does **not** prescribe a specific internal implementation. It validates external behavior and contract compliance.

---

## 2. Related documents

This document assumes consistency with the following Lucida documents:
- `docs/spec.md`
- `docs/protocol_and_schemas.md`
- `docs/sequences.md`
- `docs/storage_layout.md`
- `docs/http_and_transport.md`
- `docs/implementation_plan.md`

If this document conflicts with another Lucida spec artifact, the intended precedence is:
1. protocol/schema correctness
2. storage and transport contracts
3. acceptance criteria and gates
4. implementation plan suggestions

If an ambiguity is found during testing, the product should be considered **not yet accepted** until the ambiguity is resolved and reflected back into the relevant contract documents.

---

## 3. Acceptance philosophy

Lucida acceptance is based on five principles.

### 3.1 Contract-first validation

Lucida is a contract-driven system. Acceptance is based on adherence to:
- canonical schemas,
- state separation,
- generation semantics,
- chunk key stability,
- and the defined message and storage contracts.

### 3.2 User-visible correctness first

The system is not accepted if the user-visible result is wrong even when the internal system is "working." Examples:
- mixed-generation frames,
- stale metadata silently affecting label visibility,
- context packages reopening to a materially different view,
- derived layers appearing more precise than the LOD at which they were computed.

### 3.3 Progressive quality is allowed; inconsistency is not

Lucida is allowed to refine progressively.
It is not allowed to lie.

Acceptable:
- coarse preview first, then refinement,
- low-LOD derived layer shown at higher zoom with an explicit indicator.

Not acceptable:
- combining old and new generations within one rendered frame,
- silently displaying stale derived results as if they match the current base,
- silently using uncalibrated scale as if it were physical.

### 3.4 Collaboration must not create hidden conflicts

Lucida may allow concurrent viewers and multiple control tokens, but the user must never be unable to understand:
- who currently holds the lease,
- who changed shared scene state,
- who published derived data,
- and why a scene changed.

### 3.5 Acceptance requires operational realism

Lucida is meant for large, mutable, high-dimensional microscopy datasets. Acceptance tests must include:
- large multiscale datasets,
- mutable file-backed sources,
- sparse millions-scale label metadata,
- multi-client sessions,
- and partial/sparse derived outputs.

---

## 4. Release gates

Lucida acceptance is divided into release gates. A candidate build is accepted only if it passes all criteria for the targeted gate.

### 4.1 Gate A - Contract compliance

Gate A validates that the product obeys the schemas, identifiers, state model, and storage/transport contracts.

Required:
- protocol messages validate against schema
- chunk key and URL rules are respected
- generations and revisions behave as specified
- scene vs per-client state separation is correct
- storage layout and metadata artifacts are correctly emitted

Gate A is a prerequisite for all later gates.

### 4.2 Gate B - Core viewing correctness

Gate B validates:
- source open and first paint
- 2D navigation
- 3D entry and coarse brick rendering
- minimap correctness
- generation switching and trickle-in updates
- no mixed-generation frame rendering

### 4.3 Gate C - Analysis workflow correctness

Gate C validates:
- targets
- RegionRecipe generation
- cutout materialization
- sparse derived-layer publishing
- derived layer visibility semantics
- labels, metadata, and filter updates

### 4.4 Gate D - Collaboration correctness

Gate D validates:
- LAN/open-view and token modes
- control tokens and lease stealing
- per-client state isolation
- audit behavior
- multi-client scene updates

### 4.5 Gate E - Reproducibility and artifact correctness

Gate E validates:
- scene export and reopen
- context package capture and reopen
- thin and thick-minimal package correctness
- warning persistence and generation pinning

### 4.6 Gate F - Performance and robustness

Gate F validates:
- responsiveness targets
- load and cache stability
- filter scalability
- behavior under source churn
- resilience to disconnect/reconnect and partial build states

A public or broad internal release should not be considered complete until Gates A-F pass.

---

## 5. Test fixture matrix

Acceptance requires a stable set of reference datasets and environments.

### 5.1 Dataset fixtures

#### Fixture D1 - Small 2D image stack
Purpose: basic functional sanity.
- Shape: CZYX = 3 x 16 x 1024 x 1024
- Source format: OME-Zarr multiscale
- Uses: open, 2D navigation, context package, labels overlay

#### Fixture D2 - Medium 5D multichannel dataset
Purpose: canonical everyday microscopy workflow.
- Shape: TCZYX = 10 x 5 x 64 x 2048 x 2048
- Channels visible interactively: 1-5
- Source format: OME-Zarr multiscale
- Uses: channel blocking, z/t scrubbing, cutouts, Targets

#### Fixture D3 - Large 3D anisotropic dataset
Purpose: 3D brick behavior and anisotropy.
- Shape: CZYX = 4 x 1024 x 4096 x 4096
- Spacing: Z much coarser than XY
- Source format: OME-Zarr or TIFF source with Lucida-built cache
- Uses: orthoslices, MIP/slab, raymarch, world-space-ish brick sizing

#### Fixture D4 - Mutable source under active writes
Purpose: generation bumps and source-watch behavior.
- Source format: BigTIFF or Zarr directory
- Write pattern: repeated pipeline writes every few seconds
- Uses: stability window, working generation updates, trickle-in behavior

#### Fixture D5 - Labels with sparse millions of IDs
Purpose: labels scalability.
- Label raster with sparse original IDs
- Object count: >= 5,000,000 rows in metadata sidecar
- Metadata sidecar: SQLite
- Uses: dense remap, bitset filtering, unknown row policy, hot-reload

#### Fixture D6 - Multi-user collaboration scene
Purpose: permissions and lease behavior.
- One shared scene with multiple clients
- At least three concurrent clients:
  - one view-only
  - two control-token clients
- Uses: lease steal, per-client view isolation, shared scene edits, audit

#### Fixture D7 - Sparse derived-layer workflow fixture
Purpose: ROI prototyping loop.
- Base layer from D2 or D3
- Several saved Targets with different ROIs
- Derived layer with partial chunk coverage only
- Uses: RegionRecipe, chunked cutout, writeback, stale dependency warnings

### 5.2 Environment fixtures

#### E1 - Local workstation
- Engine and browser on same machine
- Modern laptop-class hardware

#### E2 - LAN remote client
- Engine on a stronger machine
- Browser client on separate laptop over LAN

#### E3 - Multi-client LAN session
- One engine host
- 3+ clients over LAN
- Open-view and token-view modes both exercised

#### E4 - Source churn environment
- Filesystem watcher active
- Repeated source modifications
- Build and viewer active at same time

Acceptance must cover both local and remote-LAN use. A feature that only passes locally is not accepted.

---

## 6. Core invariants (release-blocking)

The following invariants are release-blocking. Any violation is a stop-ship issue.

### 6.1 Generation integrity
- A rendered frame MUST NOT combine payloads from different generations for the same layer.
- A generation switch MUST be atomic at frame composition boundaries.
- If a newer generation is incomplete, the viewer MAY show coarser payloads from the same generation, but MUST NOT fall back to the previous generation within that layer/frame.

### 6.2 State separation
- Per-client view state changes MUST NOT mutate shared scene state unless explicitly promoted.
- Read-only clients MUST be able to modify their own per-client view state.
- Read-only clients MUST NOT mutate shared scene state.

### 6.3 Lease semantics
- Shared scene edits MUST require the lease.
- Lease stealing by a control-token client MUST work deterministically.
- Lease changes MUST be visible to all clients and MUST be audited.

### 6.4 Reproducibility honesty
- Context packages MUST encode enough information to recreate the same visualization or clearly indicate the reasons they cannot.
- Derived layers computed at LOD > 0 MUST clearly indicate their computed LOD when shown beyond that native detail.
- Stale derived layers relative to a base generation MUST remain visible only with an explicit warning.

### 6.5 Calibration honesty
- Uncalibrated layers MUST NOT be represented as physically calibrated.
- Mixed calibrated/uncalibrated overlays MUST emit warnings.

### 6.6 Sparse-layer transparency semantics
- Missing chunks in sparse derived layers MUST behave as transparent/no contribution.
- Missing chunks MUST NOT be treated as zeros.

### 6.7 Label filter correctness
- Dense remap MUST remain consistent with the active metadata revision.
- Filter bitsets MUST correspond to the metadata revision declared in the result.
- Unknown-row policy MUST be honored exactly.

---

## 7. Functional acceptance criteria

### 7.1 Session attach and capability handshake

A client attachment is accepted when:
- the client can discover or connect to a session,
- the engine returns authoritative snapshot state,
- the client registers capabilities (WebGPU limits, codec support, cache budgets),
- the client receives its per-client view state and the shared scene state,
- token scope and lease status are known immediately after attach.

Pass criteria:
- client can render a consistent initial scene without issuing extra discovery calls beyond the defined attach flow
- reconnect produces the same authoritative state after replay/snapshot recovery
- stale local prediction is reconciled cleanly on attach/reconnect

Fail criteria:
- missing lease state
- missing or ambiguous permission scope
- client renders before authoritative snapshot is available and ends in an inconsistent view

### 7.2 Source open and first 2D view

Accepted behavior:
- adding a source creates or reuses the canonical cache and stream store
- first preview appears progressively
- first quantitative tiles replace preview without visible semantic mismatch
- minimap becomes available as soon as coarse data exists

Pass criteria:
- source appears in shared scene state
- first paint occurs without blocking on full multiscale completion
- current view refines from coarse to fine monotonically within one generation
- minimap viewport rectangle matches the actual view

Fail criteria:
- no preview shown until full build completes
- tiles and minimap disagree on current field of view
- preview and refined data are from different generations with visible mismatch

### 7.3 2D navigation

Accepted behavior:
- pan, zoom, z changes, t changes, and channel visibility changes remain interactive
- checkpoints are debounced to settled states
- per-client navigation does not disturb other clients

Pass criteria:
- gesture begin/update/end transactions are reflected in audit-free per-client state
- undo returns to prior settled states, not every mouse move
- z/t scrubs settle correctly and are reflected in minimap/Z indicator where applicable

Fail criteria:
- another client's view moves unexpectedly because one client panned
- every mouse movement creates a history checkpoint
- z indicator or viewport rectangle drifts from actual display state

### 7.4 Enter 3D mode and lazy brick build

Accepted behavior:
- entry into 3D mode triggers brick availability checks and/or lazy build
- coarse bricks become visible before fine bricks are available
- 3D camera manipulations remain interactive even while refinement continues

Pass criteria:
- orthoslices, slab/MIP, and raymarch become available once coarse bricks exist
- orthoslices in 3D mode come from bricks, not 2D tiles
- anisotropic datasets do not render with obviously wrong scale proportions in world space

Fail criteria:
- 3D mode blocks until all bricks are fully built
- orthoslices use inconsistent representations within the same mode
- camera enters a visually incorrect aspect because anisotropy was ignored

### 7.5 Source update -> new working generation

Accepted behavior:
- watcher detects change
- stability window delays ingest until source is quiescent
- new working generation is created
- client can switch immediately and observe trickle-in refinement

Pass criteria:
- no mixed-generation frames
- event stream clearly indicates the new working generation
- stale derived layers are flagged when their base changed
- previous working generation is retained only according to GC policy

Fail criteria:
- client shows a visual blend of old and new generation content
- ingest begins mid-write and produces corrupted derived data
- generation switch is silent in state/events

### 7.6 Channel blocking and channel semantics

Accepted behavior:
- users select channels logically, but engine serves channel blocks
- only required blocks are fetched for the visible channel set
- per-channel contrast/colormap still behaves independently

Pass criteria:
- visible channels [0,2,4] fetch only the necessary blocks for those channels
- UI semantics remain per-channel despite block transport
- hidden channels within a fetched block do not contribute to rendering

Fail criteria:
- channel block overfetch causes incorrect visible channels
- users cannot set per-channel display parameters independently
- labels or single-channel layers are incorrectly treated as blocked multichannel data

### 7.7 Minimap correctness

Accepted behavior:
- minimap reflects active view or pinned overview layer according to scene policy
- viewport rectangle is correct
- Z indicator is correct when relevant

Pass criteria:
- minimap location and scale correspond to current view bounds
- switching to a pinned overview layer updates minimap source predictably
- context package includes minimap image consistent with viewport image

Fail criteria:
- minimap shows a different spatial region than the main display
- minimap and main view use mismatched generations for the same layer without warning

### 7.8 Labels and metadata filtering

Accepted behavior:
- labels render with outlines in 2D and orthoslices
- metadata queries produce bitsets over dense IDs
- filter changes update visibility without re-encoding the raster
- metadata hot-reload recomputes visibility automatically

Pass criteria:
- clicking or inspecting a label yields correct object metadata when present
- unknown metadata behavior follows policy exactly
- bitset updates produce correct visibility changes on GPU without client restart
- incomplete label index state is flagged when raster contains IDs missing from metadata enumeration

Fail criteria:
- metadata update requires layer reload to take effect
- filter result is computed against a stale metadata revision without warning
- labels with missing rows disappear when unknown-policy is show

### 7.9 Targets

Accepted behavior:
- targets are shared by default
- target stores navigation state and analysis ROI defaults
- any client may jump to target in its own view without changing other clients' views

Pass criteria:
- saving a target records the active base layer and viewport-derived ROI in world coordinates
- jumping to the target restores the saved navigation state accurately
- target-specific defaults are applied when omitted from cutout requests

Fail criteria:
- target jump mutates shared scene state unexpectedly
- target cannot be reproduced across clients because saved state was underspecified

### 7.10 RegionRecipe and cutout materialization

Accepted behavior:
- cutout requests resolve to a deterministic RegionRecipe
- recipe can use LOD full, match_view, or explicit integer
- cutout returns chunk references and metadata, not opaque raw blobs through control plane

Pass criteria:
- same target + same parameters produce the same recipe geometry and chunk manifest
- halo can be specified in chunks at requested LOD or world units
- 2D cutout defaults to single plane; slab works when requested
- channel selection defaults to visible channels but can be overridden

Fail criteria:
- two identical requests produce different chunk manifests without source change
- cutout geometry cannot be mapped back to base world/index coordinates unambiguously

### 7.11 Sparse derived-layer publish

Accepted behavior:
- publish batches write chunk-aligned payloads into sparse derived layers
- default publish extent includes halo; core-only is optional
- overwrite or create-new is caller-selectable
- publish does not require lease but does require control token

Pass criteria:
- missing derived chunks are transparent
- writing halo chunks improves continuity at ROI boundaries
- publish audit includes actor, chunk set, target layer, and resulting write revision
- overwrite creates new immutable chunk object URLs via write_rev/object_epoch pathing

Fail criteria:
- missing derived chunks are interpreted as zeros
- publish silently mutates a layer without revising its write revision
- two clients publishing overlapping chunks cannot be understood from audit trail

### 7.12 Derived layers across base updates

Accepted behavior:
- when base generation advances, derived layers pinned to older base remain visible with warning
- no silent auto-rebase occurs

Pass criteria:
- stale warning clearly includes base generation mismatch
- user can still inspect prior derived output without it being mistaken for up-to-date data

Fail criteria:
- stale derived layer is shown as if it matches the current base
- derived layer silently rebinds to a new generation

### 7.13 Lease, shared scene edits, and audit

Accepted behavior:
- any control token can request or steal lease
- lease changes are passive notifications
- shared edits require lease and are audited

Pass criteria:
- losing the lease does not break per-client navigation
- stealing lease immediately transfers shared-scene edit authority
- audit log contains who changed what and resulting scene revision

Fail criteria:
- clients without lease can mutate shared scene state
- lease ownership is ambiguous
- audit log cannot reconstruct order of shared scene edits

### 7.14 Scene files

Accepted behavior:
- scene files can reference pinned generations or live working references
- export warns or defaults appropriately for live references
- reopening restores shared scene configuration

Pass criteria:
- scene file reopens with correct layer stack, transforms, targets, defaults, and minimap policy
- live scenes can follow working updates if configured
- pinned scenes remain stable

Fail criteria:
- scene reopen loses shared targets or transform information
- scene import changes semantics because references were under-specified

### 7.15 Context packages

Accepted behavior:
- context package always contains guaranteed visual assets (viewport + minimap)
- if data is available, package rehydrates interactively; otherwise it still opens as frozen context

Pass criteria:
- package records exact layer/source generations used at capture time
- warnings present at capture time are preserved
- LOD/native-detail indicators are preserved
- if thick-minimal is used, embedded payloads reproduce the captured view offline

Fail criteria:
- reopened package shows a materially different view without explanation
- package omits required warning flags
- package cannot be interpreted by a consumer without hidden application state

---

## 8. Performance acceptance targets

These targets are product targets, not empirical claims about all hardware. They define pass/fail goals for supported environments.

### 8.1 General responsiveness targets

#### Local workstation (E1)
- First preview after source open: target <= 2 s, max <= 5 s
- First interactive quantitative view after source open: target <= 5 s for D1/D2, <= 10 s for D3
- 2D pan/zoom interaction latency: target <= 100 ms perceptual response, max <= 200 ms
- Z/T step response (single increment): target <= 150 ms for D2
- Minimap update after navigation settle: target <= 250 ms

#### LAN remote client (E2)
- First preview after source open: target <= 3 s, max <= 7 s
- 2D pan/zoom interaction latency: target <= 150 ms perceptual response, max <= 300 ms
- Z/T step response: target <= 250 ms

These are acceptance targets under normal LAN conditions and reasonable cache warmup assumptions.

### 8.2 3D targets

For D3 on supported hardware:
- Enter 3D mode to first coarse visible result: target <= 5 s once coarse bricks exist or are built first
- Orthoslice manipulation: target interactive response <= 200 ms
- Slab/MIP update after parameter change: target <= 300 ms
- Raymarch refinement should remain visually progressive without freezing the UI for > 500 ms

Lucida is accepted if 3D remains usable progressively. It is not required that full-quality raymarch be immediately available.

### 8.3 Label filtering targets

For D5:
- Filter query evaluation and bitset generation: target <= 2 s for common queries, max <= 5 s
- Visibility update at client after bitset arrival: target <= 500 ms
- Hot-reloaded metadata change to refreshed visibility: target <= 3 s common case

### 8.4 Cutout and publish targets

For D7:
- RegionRecipe generation: target <= 500 ms
- Cutout reference response (not byte transfer): target <= 1 s
- Publish batch commit to visible sparse layer update: target <= 2 s once chunk objects are staged

### 8.5 Robustness under source churn

For D4:
- Repeated source writes must not crash the engine
- Engine must debounce correctly and avoid runaway rebuild loops
- Client should remain navigable while new generation is being built
- Memory usage must remain bounded according to configured cache budgets

Performance acceptance failure is release-blocking if the system consistently misses these targets on supported environments, even when functionality is correct.

---

## 9. Reliability and robustness acceptance

### 9.1 Reconnect and snapshot recovery

Accepted behavior:
- client disconnect/reconnect restores authoritative state via replay or snapshot
- local speculative state is discarded/reconciled safely

Pass criteria:
- reconnection does not duplicate commands
- client returns to correct per-client view state
- no stale lease or token assumptions persist after reconnect

### 9.2 Partial build states

Accepted behavior:
- partially built generations remain viewable progressively
- unavailable chunks fall back to coarser chunks of the same generation

Fail criteria:
- unavailable chunks silently fall back to previous generation
- UI freezes while waiting for full fine-resolution completion

### 9.3 Upload/publish robustness

Accepted behavior:
- staged uploads can fail or expire without corrupting derived layer state
- partially uploaded publish batches do not become visible until committed

Pass criteria:
- publish batch is atomic at commit boundary
- abandoned upload objects are garbage-collected eventually

### 9.4 Metadata mismatch robustness

Accepted behavior:
- if metadata sidecar enumerates fewer IDs than present in raster, layer stays viewable
- incomplete-index warning is surfaced

Fail criteria:
- layer becomes unusable because metadata is incomplete
- filter results silently claim completeness when index is incomplete

---

## 10. Security and permission acceptance

### 10.1 Open-view mode

In LAN open-view mode:
- viewers on the LAN can attach and read state/data-plane content
- control actions still require control token

Acceptance requires:
- view-only users cannot perform shared scene edits
- read-only clients may still modify their own view state

### 10.2 Token-view mode

When enabled:
- view token is required for view attachment and data fetches
- tokenized share links work reliably

Acceptance requires:
- token leakage through obvious URL logging should be minimized where possible
- control token is still distinct from view token

### 10.3 Control tokens and ACLs

Acceptance requires:
- control token can acquire/steal lease
- publish to derived layer obeys control token and optional layer write ACL
- revoked tokens lose authority immediately or at next defined revalidation point

---

## 11. Warning taxonomy acceptance

The following warnings MUST be representable in state and artifacts and MUST appear when applicable:
- `uncalibrated_layer`
- `mixed_calibration_overlay`
- `stale_derived_dependency`
- `incomplete_label_index`
- `computed_at_lod`
- `generation_build_incomplete`

Acceptance requires:
- warnings appear in UI state, context packages, and relevant scene/context artifacts
- warnings are not lost on export/import
- warnings clear when the underlying condition clears

---

## 12. Acceptance test cases by workflow

This section defines concrete release-blocking workflow tests.

### 12.1 AT-01: Open a medium 5D dataset and navigate in 2D

Fixture: D2 on E1 and E2.

Steps:
1. Open source.
2. Wait for first preview and first quantitative refinement.
3. Pan, zoom, change z, change t, toggle channels.
4. Capture context package.

Expected:
- preview and refinement are progressive within one generation
- channel blocking is invisible at UI level
- minimap matches view
- context package reopens to the same view and warning state

### 12.2 AT-02: Enter 3D mode on anisotropic data

Fixture: D3 on E1.

Steps:
1. Open dataset in 2D.
2. Enter 3D mode.
3. Use orthoslices, slab, and raymarch.
4. Rotate and zoom camera.

Expected:
- coarse bricks appear first
- world-space anisotropy is respected
- orthoslices derive from brick representation
- interaction remains progressive and usable

### 12.3 AT-03: Source change under active viewing

Fixture: D4 on E2.

Steps:
1. View mutable source.
2. Trigger source writes repeatedly.
3. Observe generation bump and trickle-in update.

Expected:
- no mixed-generation rendering
- state/event stream reports new working generation
- client remains navigable during rebuild

### 12.4 AT-04: Label filtering at scale

Fixture: D5 on E1.

Steps:
1. Load labels and metadata sidecar.
2. Apply several metadata filters.
3. Toggle unknown-policy show/hide.
4. Modify metadata and hot-reload.

Expected:
- filter bitsets match expected object counts
- visibility updates without raster reload
- hot-reload recomputes and updates visibility automatically
- incomplete-index warning appears if metadata omits IDs present in raster

### 12.5 AT-05: Target -> cutout -> prototype -> publish sparse derived layer

Fixture: D7 on E1/E2.

Steps:
1. Save several Targets.
2. Generate cutout from target A at LOD0 with halo.
3. Simulate compute using chunked cutout.
4. Publish derived chunks as new sparse layer.
5. Publish again with overwrite enabled.
6. Repeat for another target using `lod="match_view"`.

Expected:
- RegionRecipe is deterministic and includes resolved chunk blocks
- default publish includes halo
- sparse derived layer shows only published regions; missing regions are transparent
- overwrite increments write revision and produces auditable history
- if published at nonzero LOD, layer clearly indicates computed LOD when zoomed in

### 12.6 AT-06: Multi-client collaboration and lease stealing

Fixture: D6 on E3.

Steps:
1. Client A obtains lease and edits shared scene.
2. Client B steals lease.
3. Client C is view-only and changes its own camera.
4. Client B publishes sparse derived chunks.

Expected:
- lease change is visible to all clients
- client C cannot edit shared scene but can alter own view
- audit log reconstructs shared scene edits and publish operations unambiguously

### 12.7 AT-07: Scene export and reopen

Fixture: D2/D7 on E1.

Steps:
1. Create scene with multiple layers, Targets, and one derived layer.
2. Export pinned scene.
3. Reopen on another client.

Expected:
- scene reopens with same shared configuration
- targets, transforms, minimap policy, and layer order preserved
- pinned references remain stable

### 12.8 AT-08: Context package reopen without dataset access

Fixture: any scene with warnings and minimap.

Steps:
1. Capture thin context package.
2. Open it in a context where underlying data is unavailable.

Expected:
- guaranteed visual assets are visible
- metadata and warnings are preserved
- package is still interpretable as frozen context

---

## 13. Test methodology

### 13.1 Validation layers

Each feature should be validated at four layers where applicable:
1. Schema validation
2. Transport/storage contract validation
3. End-to-end behavior validation
4. User-visible visual validation

### 13.2 Visual validation

For user-visible viewer features, acceptance cannot rely only on protocol assertions. Required checks include:
- main viewport image correctness
- minimap correctness
- warning visibility
- label outline visibility
- sparse transparency correctness
- LOD-native-detail indicators

### 13.3 Deterministic test hooks

The engine SHOULD expose test hooks or deterministic modes for:
- freezing generation switch points
- forcing certain LOD availability states
- simulating delayed chunk builds
- simulating metadata revision changes
- simulating lease steal and reconnect events

These are strongly recommended for repeatable acceptance testing.

---

## 14. Release-blocking failure classes

The following failures are stop-ship:
- mixed-generation frame composition
- shared/per-client state contamination
- unauthenticated shared scene edits
- incorrect lease enforcement
- corrupted or ambiguous chunk key addressing
- incorrect label filter visibility results
- missing or false warning states for calibration, dependency, or LOD honesty
- broken context package reproducibility
- derived sparse layers treating missing chunks as zeros
- nondeterministic RegionRecipe generation for stable inputs
- source watch behavior causing repeated ingest corruption or runaway rebuild loops

The following are high severity but not automatic stop-ship unless pervasive:
- performance misses slightly above targets in edge environments
- occasional delayed minimap updates under heavy load
- non-critical audit log formatting issues with no data loss

---

## 15. Definition of done

Lucida is "accepted" for a given release target when:
- all required documents and schemas are internally consistent,
- Gates A-F pass for the targeted scope,
- all release-blocking workflow tests pass on the required fixture matrix,
- no stop-ship invariant violations remain open,
- and any intentionally deferred items are documented explicitly rather than left ambiguous.

For a broad internal release, the minimum expected acceptance scope is:
- contract compliance
- 2D and 3D viewing correctness
- labels and filtering correctness
- targets/cutout/publish workflow
- collaboration and permissions
- context package and scene reproducibility
- baseline performance on local and LAN environments
