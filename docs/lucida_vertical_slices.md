# Lucida Vertical Slices

Version: 0.1 draft  
Date: 2026-02-28  
Status: Execution roadmap distilled from `implementation_plan.md`, `spec.md`, `protocol_and_schemas.md`, `sequences.md`, and `acceptance.md`

## 1. Purpose

This document extracts the **implementation progression** for Lucida into a small number of integrated **vertical slices**.

It is intended to answer:
- what engineering should build first
- what each slice proves end-to-end
- what teams can work on in parallel inside each slice
- what must be true before moving to the next slice
- what is deliberately deferred

This is the document that should drive day-to-day implementation progression.  
The larger implementation plan remains the deeper ticket reference.

## 2. What a “vertical slice” means here

A Lucida vertical slice is **not** just a subsystem completion milestone.

A slice must include:
- engine behavior
- data/storage behavior
- client behavior
- tool surface behavior where needed
- acceptance coverage

A slice is complete only when a user-visible loop works end-to-end against the actual contracts.

## 3. Planning principles

1. **Contracts first, UI polish later.**  
   Schema and storage correctness matter more than visual completeness early on.

2. **Integrated loops beat subsystem completion.**  
   A narrow working loop is more valuable than a half-finished broad surface.

3. **2D first, then artifacts, then labels, then 3D, then prototyping, then collaboration hardening.**  
   This is the lowest-risk order for Lucida’s architecture.

4. **Do not reopen product decisions during slice implementation.**  
   Use the frozen spec set unless a hard contradiction appears.

5. **Every slice must preserve core invariants.**  
   Especially:
   - authoritative engine state
   - shared scene vs per-client view split
   - generation consistency
   - immutable data-plane payload addressing
   - world-space-first transforms
   - auditability of shared edits and publishes

## 4. Slice summary

| Slice | Name | Primary user-visible outcome | Main acceptance gate |
|---|---|---|---|
| S0 | Contracts and foundation | Repo, schemas, CI, session skeleton are real and stable | M0 |
| S1 | First integrated 2D session | Open a source and interact with a real 2D viewer with preview/refinement | M1 |
| S2 | Scene artifacts and shared navigation | Save/open scenes, capture context packages, use shared targets | M2 |
| S3 | Labels and metadata intelligence | Labels render with outlines and metadata-driven filtering | M3 |
| S4 | 3D interactive viewing | Enter 3D, use orthoslices, MIP/slab, and raymarch progressively | M4 |
| S5 | ROI prototyping loop | Cut out chunks from a view/target and publish sparse derived results back | M5 |
| S6 | Collaboration, auth, and hardening | Tokens, lease stealing, ACLs, audit, and release-grade robustness | M6 |

## 5. Cross-slice invariants

These are release-blocking invariants that apply to every slice:

- the engine is always authoritative for shared state
- per-client view state never silently mutates shared scene state
- a frame never mixes generations for the same layer
- all shared scene edits are attributable
- all derived-layer publishes are attributable
- warnings are surfaced consistently in state and exported artifacts
- chunk payloads are immutable-addressed at the data plane
- scenes and context packages preserve enough provenance to reproduce what was seen

## 6. Recommended team lanes

The slices assume these lanes can work in parallel once contracts are frozen:

- **ARCH** — architecture, contracts, ADRs, orchestration
- **ENG** — engine/control plane/session/state
- **DATA** — source watch, ingest, cache build, storage layout
- **WEB** — browser client, WebGPU, request scheduling, UX
- **TOOLS** — Python, CLI, Jupyter surfaces
- **QA** — acceptance, fixtures, performance, observability

## 7. Slice details

---

## S0 — Contracts and foundation

### Objective

Create the implementation substrate so downstream slices can proceed in parallel without interface churn.

### What this slice proves

- the spec set is frozen enough to build against
- repo structure and CI exist
- the engine can host sessions and emit snapshots/events
- engineering can develop against stable contracts rather than verbal design

### User-visible demo

A developer can:
- run the engine
- create/attach to a session
- receive a valid snapshot and event stream
- see IDs/revisions/events behaving consistently in logs or a minimal debug client

### Scope included

- protocol/schema review closure
- ADRs for non-reopenable architecture choices
- repo/bootstrap/CI
- ticket tracker import
- session service skeleton
- ID/revision allocator
- command validation/routing skeleton
- event emission skeleton
- typed error model
- warning taxonomy skeleton
- acceptance matrix bootstrap

### Explicitly out of scope

- full source open and image rendering
- real data-plane chunk fetching
- 3D rendering
- ROI workflows
- collaboration polish

### Primary tickets

- LUC-000 to LUC-003
- LUC-100 to LUC-107

### Entry criteria

- spec docs exist and are internally coherent
- protocol/schema draft exists
- sequence draft exists

### Exit criteria

- schema and sequence review points are frozen or explicitly marked deferred
- repo and CI are live
- session attach returns snapshot successfully
- typed events and typed errors exist
- revision model is functioning
- acceptance matrix exists and maps to milestone gates

### Dependencies unlocked

S0 unlocks all later slices.

### Key risks

- schema churn after implementation begins
- unclear state diff semantics
- inconsistent revision handling across engine/client

### Notes for execution

Do not spend time polishing developer UX here.  
The goal is stable contracts and a running skeleton.

---

## S1 — First integrated 2D session

### Objective

Deliver the first real Lucida loop:
**open source → build cache → first preview → refine → interact in 2D**.

### What this slice proves

- source watching and generation creation are real
- canonical cache + 2D representation can be built
- the browser client can attach, fetch tiles, and render
- 2D navigation semantics are stable
- generation consistency invariant holds during refinement and source churn

### User-visible demo

A user can:
- open a TIFF/Zarr/OME-Zarr source
- see a first preview quickly
- watch it refine progressively
- pan/zoom
- change z/t and channel selections
- see minimap and warning badges
- reconnect without losing session semantics

### Scope included

**Engine / data**
- source registry and inspection
- watcher + stability window
- generation state machine
- canonical OME-Zarr cache builder
- 2D tile and preview builder
- channel-blocked packaging
- central cache layout and GC basics
- chunk key parser/formatter
- HTTP data plane for tiles/previews
- immutable payload headers and cache semantics

**Client**
- attach/auth/capability handshake
- client state store and reconciliation
- request scheduler + cancellation
- CPU/GPU caches
- 2D renderer
- 2D interaction model
- minimap
- warning surfaces

**Tools**
- Python command bindings
- CLI basic open/pan/set/overview flows
- Jupyter shell scaffolding sufficient to embed the web client

**QA**
- fixture corpus bootstrap
- end-to-end harness basics
- generation consistency tests for 2D

### Explicitly out of scope

- scene files and context packages
- shared targets
- labels metadata filtering
- 3D rendering
- ROI cutouts and derived layers
- lease/auth collaboration features beyond foundational plumbing

### Primary tickets

- LUC-200 to LUC-207
- LUC-300 to LUC-305
- LUC-400 to LUC-406
- LUC-500 to LUC-502
- LUC-1100 to LUC-1102 (relevant subset)

### Entry criteria

- S0 complete
- session/control skeleton stable

### Exit criteria

- a supported source can be opened into a session
- first preview appears and higher detail refines
- pan/zoom/z/t/channel selection work end-to-end
- minimap works
- reconnect works
- no mixed-generation frame is observed under source updates
- 2D acceptance gate M1 passes

### Dependencies unlocked

S1 unlocks:
- scene artifacts
- labels work
- 3D entry
- ROI prototyping

### Key risks

- poor boundary between canonical cache and 2D representation
- browser request overhead dominating when multi-channel tiles are fetched
- source stability window causing thrash or lag

### Notes for execution

This is the first slice that should feel like “Lucida exists.”

---

## S2 — Scene artifacts and shared navigation

### Objective

Add durable scene-level artifacts and shared navigation primitives so users can preserve, reopen, and share what they are doing.

### What this slice proves

- scene state can be serialized/deserialized coherently
- context packages capture the same context the user sees
- targets are real shared objects, not just local bookmarks
- warnings and provenance are preserved in exported artifacts

### User-visible demo

A user can:
- create shared targets from the current view
- jump to targets from another client
- export a scene file and reopen it
- capture a context package and reopen it into the same visualization
- see warnings preserved in artifacts

### Scope included

- shared scene model and layer-order service
- target model and shared target service
- scene file export/import
- context package capture (thin + guaranteed visual)
- optional thick-minimal context package mode
- promotion of per-client render settings to shared defaults
- CLI and Python surfaces for targets/scenes/context packages

### Explicitly out of scope

- metadata-aware labels beyond basic layer persistence
- 3D rendering
- ROI cutouts and sparse derived publishing
- collaboration auth/lease polish

### Primary tickets

- LUC-503 to LUC-504
- LUC-600 to LUC-605

### Entry criteria

- S1 complete
- stable shared scene model from S0/S1

### Exit criteria

- targets are shared scene objects and persist correctly
- scene files round-trip correctly
- context packages capture exact rendered viewport + minimap + provenance
- reopening scene/context artifacts recreates the intended visualization state
- M2 acceptance gate passes

### Dependencies unlocked

S2 unlocks:
- target-driven ROI prototyping
- reproducible collaboration artifacts
- LLM-facing workflow grounding

### Key risks

- ambiguity between scene files and context packages
- incomplete warning/provenance capture
- drift between shared defaults and per-client render state

### Notes for execution

This slice should make Lucida feel durable, not ephemeral.

---

## S3 — Labels and metadata intelligence

### Objective

Make labels a first-class analysis layer with scalable metadata-driven filtering.

### What this slice proves

- label rendering is performant and visually useful
- sparse millions of object IDs can be handled interactively
- metadata hot-reload actually changes what users see
- the filter DSL is viable for UI, CLI, and LLM use

### User-visible demo

A user can:
- open a labels layer with outlines
- load a SQLite metadata sidecar
- apply a metadata filter
- see label visibility update interactively
- click/inspect labels and view metadata
- see warnings when metadata/index coverage is incomplete

### Scope included

- labels layer rendering + outlines
- dense ID remap builder and persistence
- SQLite sidecar schema/loader
- filter DSL parser/validator/evaluator
- visibility bitset generation, compression, and client upload
- metadata hot-reload and active-filter recompute
- metadata-driven color/inspection paths
- warnings for incomplete label index and metadata mismatch
- relevant HTTP endpoints and client UI surfaces

### Explicitly out of scope

- editable labels/painting
- label meshes/isosurfaces in 3D
- ROI cutout/publish loops
- advanced collaboration controls

### Primary tickets

- LUC-304
- LUC-700 to LUC-707
- LUC-1103

### Entry criteria

- S1 complete
- S2 helpful but not strictly required if target artifacts are decoupled

### Exit criteria

- label outlines render correctly in 2D
- dense remap works for sparse large ID spaces
- metadata sidecars hot-reload without restarting the session
- filter bitsets update visibility interactively
- incomplete index conditions are surfaced as warnings
- M3 acceptance gate passes

### Dependencies unlocked

S3 unlocks:
- richer analysis sessions
- label-aware context packages
- metadata-conditioned prototyping loops

### Key risks

- dense remap performance and memory overhead
- bitset transport latency for huge label universes
- metadata/raster mismatch edge cases

### Notes for execution

This slice should be tested with truly large sparse-ID fixtures, not toy labels.

---

## S4 — 3D interactive viewing

### Objective

Bring Lucida’s second core representation online:
**lazy-built 3D bricks** powering orthoslices, slab/MIP, and raymarch.

### What this slice proves

- the 3D brick representation is worth its storage/build cost
- 3D can enter progressively without breaking 2D semantics
- world-space-ish brick shaping and LOD selection are viable
- the same session model supports 3D cleanly

### User-visible demo

A user can:
- switch into 3D mode
- wait for coarse bricks if needed
- use orthoslices
- use slab/MIP
- use basic volume raymarch
- navigate in 3D with stable camera target behavior
- see progressive refinement and quality indicators

### Scope included

- lazy 3D brick builder
- brick request planner
- orthoslice renderer from bricks
- slab/MIP renderer
- raymarch renderer
- brick autotuner
- 3D entry and progressive UX
- 3D camera target semantics
- relevant perf harness work

### Explicitly out of scope

- isosurfaces/meshes for labels
- advanced 3D annotation tools
- ROI compute/writeback loop
- full collaboration hardening

### Primary tickets

- LUC-205
- LUC-800 to LUC-805
- LUC-1104

### Entry criteria

- S1 complete
- brick storage path and transport path stable enough
- acceptance harness supports 3D fixtures

### Exit criteria

- entering 3D mode triggers lazy brick build and becomes usable progressively
- orthoslices, slab/MIP, and raymarch work from brick representation
- camera target semantics are stable
- brick autotuning behaves within expected ranges
- M4 acceptance gate passes

### Dependencies unlocked

S4 unlocks:
- 3D RegionRecipe cutouts
- 3D sparse derived volumes
- future advanced 3D plugins

### Key risks

- brick build cost too high for practical iteration
- raymarch performance on non-workstation laptops
- confusion between 2D tile semantics and 3D brick semantics

### Notes for execution

Do not optimize for visual polish before validating brick scheduling and upload behavior.

---

## S5 — ROI prototyping loop

### Objective

Deliver Lucida’s defining analysis workflow:
**select view/target → generate RegionRecipe → materialize chunked cutout → run compute → publish sparse derived layer chunks**.

### What this slice proves

- Lucida can be used as a serious prototyping surface, not just a viewer
- the chunk-aligned ROI model is practical
- derived layers can stay sparse and useful
- LOD-aware cutouts and publish semantics are coherent

### User-visible demo

A user can:
- save a target
- request a cutout at `lod="full"`, `lod="match_view"`, or an explicit LOD
- receive a chunked cutout including halo
- run some analysis externally
- publish the result as a new derived layer or overwrite an existing one
- see the new derived data appear only where computed
- toggle stale-dependency and computed-at-LOD warnings/provenance

### Scope included

- RegionRecipe generator
- cutout materialization service
- chunked cutout adapters for Python ergonomics
- derived layer model and dependency policy
- publish batch ingest and write revisioning
- halo/core publish semantics
- LOD provenance handling
- transparency semantics for sparse derived layers
- overwrite vs new-layer publish flows
- CLI/Python/Jupyter surfaces for target/cutout/publish

### Explicitly out of scope

- generalized workflow orchestration engine
- automatic pipeline execution service inside Lucida
- advanced collaborative editing of derived layers beyond ACLs and audit
- semantic diffing or merge of derived results

### Primary tickets

- LUC-503
- LUC-900 to LUC-907

### Entry criteria

- S2 complete for targets and artifacts
- S1 complete for 2D cutouts
- S4 complete for 3D cutouts if 3D ROI support is in-scope for the first pass

### Exit criteria

- RegionRecipes resolve deterministically
- cutouts materialize at selected LOD with halo rules respected
- publish writes sparse derived chunks successfully
- missing chunks remain transparent
- overwrite and new-layer flows both work
- stale-base and computed-at-LOD warnings are exposed correctly
- M5 acceptance gate passes

### Dependencies unlocked

S5 unlocks:
- actual experimental analysis workflows
- rapid local iteration loops
- LLM-assisted region-specific compute flows

### Key risks

- friction in the Python cutout/publish ergonomics
- mismatch between cutout chunk grids and derived write grids
- users misinterpreting partial sparse outputs as full-coverage results

### Notes for execution

This slice should include at least one polished notebook example.  
If the ROI loop is clumsy, the product’s differentiation weakens.

---

## S6 — Collaboration, auth, and hardening

### Objective

Finish the system behaviors needed to run Lucida safely and reliably in a collaborative LAN environment and prepare for a production-grade release.

### What this slice proves

- exposure modes are trustworthy
- shared edits are governable
- derived publishing can be controlled and audited
- the system survives churn, reconnects, and realistic workloads
- the release is operationally supportable

### User-visible demo

A user can:
- run Lucida in open-view LAN mode or token-view mode
- share a view link
- use control tokens
- steal the lease and see passive notifications
- publish derived chunks with ACLs enforced
- inspect audit history
- see client roster/collaboration state
- rely on the system under source churn and reconnect conditions

### Scope included

- token service and share-link model
- LAN exposure mode controls
- derived layer write ACLs
- audit log storage and query surface
- collaboration indicators / client roster
- observability and telemetry
- generation-consistency and churn tests
- developer docs/runbooks/examples
- release hardening against acceptance matrix

### Explicitly out of scope

- enterprise IAM integration beyond the chosen token model
- cloud/CDN production deployment optimization beyond compatibility hooks
- pixel-stream broadcast features

### Primary tickets

- LUC-1000 to LUC-1004
- LUC-1101 to LUC-1106

### Entry criteria

- S1 through S5 complete enough that real workflows exist
- transport and storage docs stabilized

### Exit criteria

- open-view and token-view modes both work
- lease steal path is correct and audited
- derived-layer ACLs are enforced
- audit query surface is usable
- operational telemetry exists
- acceptance gates for robustness/security/performance pass
- M6 acceptance gate passes

### Dependencies unlocked

S6 is the release-hardening slice for Lucida core.

### Key risks

- token/lease behavior being confusing in practice
- lack of enough observability to debug generation churn
- test harness not matching real workloads closely enough

### Notes for execution

This slice should be where Lucida starts to feel “deployable,” not just “interesting.”

## 8. Suggested implementation order inside each slice

For each slice, use this internal rhythm where possible:

1. **Contract confirmation**
2. **Engine/data skeleton**
3. **Client rendering / UX skeleton**
4. **Tool surface**
5. **Integrated demo**
6. **Acceptance and hardening**

This avoids front-end or tooling work getting too far ahead of real engine behavior.

## 9. Parallelization guidance

Once S0 is complete:

- **ENG + DATA + WEB** can progress together on S1
- **TOOLS** can follow one step behind the engine/client contracts
- **QA** should build fixtures and the acceptance harness continuously, not at the end

Recommended overlap:
- Near the end of S1, begin S2 contract validation and S3 metadata/storage preparations
- Near the end of S3, begin S4 performance harness work
- Near the end of S4, begin S5 notebook ergonomics and publish-path plumbing
- S6 should start operationally before S5 is fully complete, but finish after real workflows exist

## 10. What should be treated as the slice “demo”

At the end of every slice, insist on a demo script that can be run repeatedly.  
Each slice should have a single canonical demo:

- **S0:** attach to a session and inspect a valid snapshot/event stream
- **S1:** open source and interact in 2D while preview/refinement happens
- **S2:** save a target, export a scene/context package, reopen it
- **S3:** filter labels by metadata and watch visibility update live
- **S4:** switch to 3D and use orthoslices + MIP + raymarch
- **S5:** cut out a target region, run a toy compute step, publish sparse derived results
- **S6:** connect multiple clients, use tokens/lease/audit, survive reconnect and source churn

## 11. What to defer aggressively

To keep progression clean, the team should defer these until their natural slice:

- 3D polish before S4
- ROI compute ergonomics before S5
- advanced collaboration UI before S6
- plugin ecosystem work before core slices are stable
- cloud/CDN optimization before the local/LAN path is solid
- pixel-stream/broadcast features until after core collaboration and data access patterns are stable

## 12. Relationship to the larger implementation plan

Use this document for:
- milestone planning
- engineering sequence
- cross-team coordination
- demo expectations
- “what slice are we in?”

Use `implementation_plan.md` for:
- ticket-level execution
- dependency tracking
- staffing and sizing
- critical path details
- risk tracking

## 13. Definition of progression success

The Lucida implementation progression is healthy when:
- each slice ends in a real end-to-end loop
- the next slice starts from a stable substrate, not a pile of TODOs
- acceptance gates are passed at the slice boundary, not deferred
- the implementation plan and acceptance docs remain aligned with the actual product state
