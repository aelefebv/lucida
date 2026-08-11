---
type: Decision
title: "Debug surface dispositions"
description: "The ten-tab debug panel is dismantled: observation moves to the monitor where it is temporal and to the trace where it is a per-tick count, is deleted where it is neither, and mutation keeps one small dev-only surface."
tags: [lucida, decision]
source_path: wiki/decisions/0052-debug-surface-dispositions.md
created: 2026-08-10
modified: 2026-08-10
---

# Debug surface dispositions

Status: Accepted

Context: issue [#896], under the [#885] map. Consumes the inventory from [#889]
(`docs/research/debug-surface-audit.md`, branch `research/debug-surface-audit`)
and the monitor design from [#892]. Depends on
[0047](0047-trace-model-phases-runs-and-lifecycle-rows.md) for what the monitor
records and [0049](0049-unconditional-recording-under-a-design-budget.md) for
the cost contract it records under. Overlaps
[0043](0043-superseded-server-surfaces-sunset.md) §C, whose deletion follow-up
has not landed. Amends [0012](0012-logging-conventions.md).

[#885]: https://github.com/aelefebv/lucida/issues/885
[#889]: https://github.com/aelefebv/lucida/issues/889
[#892]: https://github.com/aelefebv/lucida/issues/892
[#896]: https://github.com/aelefebv/lucida/issues/896
[0012]: 0012-logging-conventions.md
[0043]: 0043-superseded-server-surfaces-sunset.md
[0047]: 0047-trace-model-phases-runs-and-lifecycle-rows.md
[0049]: 0049-unconditional-recording-under-a-design-budget.md

## The decision

**Observation moves to the monitor where it is temporal and to the trace's
per-tick aggregate table where it is a count. It is deleted where it is neither.
Mutation keeps one small dev-only surface.** `DebugPanel.tsx` — 1,966 lines, ten
tabs, shipped in production builds — is deleted. No compatibility layer, per the
repo's no-back-compat rule.

The disposition table is the appendix to this record. The load-bearing part is
the principle above, and the two corrections below that produced it.

## "Absorbed" was available for far less of the panel than expected

[#885] frames the fate of each item as one of three: absorbed by the monitor,
kept as config, or deleted. Working the inventory item by item, *absorbed* turned
out to cover a minority of what is on screen.

The monitor records **timing** — phases, runs, per-chunk lifecycle rows
([0047]). [#885]'s own diagnosis of the existing surface is that "everything
instrumented today is a **gauge** — the value *right now*." Those are
complements, not a superset and a subset. Frame/plan/upload milliseconds, decode
p50/p95, the rolling one-second upload rates and the cold-state rebuild
percentiles are genuinely temporal and genuinely absorbed. Scene epochs,
ray-pick results, the asset catalog, active-set membership, per-LOD
planned/cached counts and the culling funnel are not, and never become so.

Marking those *absorbed* would have deleted real capability under a label
asserting it was preserved. That is the failure this ADR exists to prevent, and
it is the same class of error [#889] found three times inside the panel itself:
a surface that displays a confident zero for something it never measures reads
as "measured and fine."

## The agent surface looked like a fourth fate until its transport was checked

The apparent fix was a fourth disposition — *moved to the agent surface* —
resting on [#885] preference 7, that `lucida debug state` is the agent pipe to
extend. Structural state is exactly what the CLI already carries, and
`debug state` self-declares the gap in `debug_state_caveats()`: it "does not
include browser renderer residency, CPU-cache state, or worker wanted-set
state."

**The CLI cannot reach browser state.** All three diagnostics open a workspace
WebSocket and derive their answer from server/scene state; `--from-peer` reads a
peer's *presence*, which carries camera and view, not cache residency. The
caveat names a gap in the *data*, but closing it is not a new output block — it
is new wire to publish browser state out of the browser, spending from [0049]'s
budget to preserve a gauge board nobody has requested since.

So the fourth fate does not survive as a general destination. What survives is
narrower and free:

- **Per-tick counts ride the trace.** Lane counts, per-LOD
  planned/cached/in-flight, the culling funnel and active-set mode tallies are
  already the shape of [0047]'s per-tick aggregate table. They reach agents
  through the trace export and through `lucida trace <dataset>` driving a
  headless run ([#885] preference 8), over a browser-side path the monitor is
  building anyway.
- **Health needed no migration at all.** `lucida dataset health` already returns
  the identical `DatasetSourceHealth` wire type the Health tab renders — the one
  place a GUI and an agent surface already read the same bytes. The web tab is
  redundant, not portable.

Everything left over — the focal-entity inspector, the entity-coords overlap
check, `view_query` dumps, ray-pick — is an ad-hoc probe with no ongoing
consumer, and is deleted.

## Mutation keeps one surface, named for mutation

The surviving surface is **Dev controls** (`DevControls`), a standalone
dev-gated surface mounted from the toolbar, not a tab and not folded into
settings — settings is a user surface. It holds:

- the planning knobs currently in `ConfigTab.tsx` (478 lines, 292 lines of
  tests, backed by `configStore` via `useSyncExternalStore`),
- the six `debug.overlays` toggles, and
- the four session-scoped `CpuCache` knobs from the Cache tab.

It is named for *mutation* rather than for configuration because configuration
is only one of its three contents; naming it `PlannerConfig` would misdescribe
it on the day it ships.

Two properties carry forward deliberately:

- **"Reset all to defaults" stays enabled in production builds.** Knobs
  persisted by a dev session keep steering the planner in production, and this
  is the only way out.
- **The session-scoped knobs must be visibly marked as such.** `updateConfig` is
  an `Object.assign` onto a live `CpuCache`; those four knobs do not persist and
  die on reload, while their neighbours persist across sessions. Four controls
  that silently reset sitting beside controls that do not is a trap, so the
  lifetime boundary belongs in the UI, not only in the code.

The hazard [#889] flagged — `ConfigTab`'s radius slider driving a transient
overlay boundary through `setRenderRadiusPreviewTier`, a mutate surface reaching
into an observe surface — **evaporates rather than needing mitigation**. With
the overlay toggles moving into Dev controls, the preview is one surface driving
a layer it owns. The three functions stay in `logging.ts`, untouched.

## The overlays survive, decoupled, and do not fold into the monitor

`DebugOverlays.tsx` (1,267 lines) is the only part of the inventory the monitor
structurally cannot replace: it answers *which chunk, where on screen* —
spatial, not temporal. Neither a timeline nor Perfetto can draw it. `plannedRank`
in particular is the direct visual of the admission window in
[0044](0044-bounded-admission-window-for-an-oversubscribed-wanted-set.md).

Folding an in-viewport `pointer-events: none` layer into a separate page would
be a category error — its entire value is registration with the pixels beneath
it. It is also *already* nearly independent: state lives in
`localStorage["debug.overlays"]`, the layer is lazy-loaded and returns `null`
when nothing is enabled. The only work is severing the `showDebug` half of its
mount condition (`App.tsx:1413`) so it outlives the panel. All six overlays are
kept.

## The log stream keeps its console interface and loses its checkboxes

The Logging tab was two unrelated registries sharing a panel: the five
`localStorage.debug` categories of [0012] and the six overlay toggles. They part
along the seam that was always between them.

The **category checkboxes are deleted with no replacement UI.**
`localStorage.debug = 'bridge,cache'` plus a reload is the documented interface
and already works with no panel — the checkbox grid was a UI over a one-line
console incantation. The **overlay toggles move to Dev controls**, since the
overlays survive and would otherwise have no control.

[0012] is amended, not superseded: its convention — `tracing` server-side,
`bridgeLog` client-side, `dot.scope` event names — is still correct. What decays
is its reference to `DebugPanel.tsx` as the Logging tab UI, and its
"DebugPanel toggle has a bootstrap gap" trade-off, which describes a toggle that
will no longer exist. With no toggle there is no freshly-flicked-toggle gap;
reload *is* the interface.

Separately, `upload.resend_storm` is deleted: a live log site that can never
fire, because its only `recordEvent` caller passes `isResend: false`
unconditionally.

## What is dead by [0043], not by this ADR

The Catalog tab observes a path that no longer executes. `legacy_proxy_enabled`
defaults to `false`, so `proxy_catalog_entries_for_manifest` returns an empty
vector and no `AssetCatalogUpdate` is ever constructed server-side; the asset
epoch never leaves 0. On the web side `assignCoarseDetailModes` emits only
`tile` and `invisible` entries with `proxyAvailable: false`, so `proxyRequests`
is permanently empty — which also makes the Cache tab's proxy rows and the whole
of `ProxyResidencyDebug` structurally zero, including `topDecisions[]`, built
twenty entries deep every tick and never displayed.

[0043] §C already commits to deleting that substrate — `pipeline/assetCatalog.ts`,
the asset epoch, the `cpuCache` proxy branches, the renderer proxy residue, the
`lucida-proxy` crate — in a named follow-up that has not landed. **This ADR
depends on that follow-up; it does not absorb it.** Folding a whole-crate
server-and-renderer deletion into a debug-surface disposition would make neither
shippable. The one item that does belong here is the **`coarseDetailEnabled`
toggle**, which [0043] also names: it lives on the surface being restructured, so
Dev controls inherits the obligation to drop that knob when [0043]'s follow-up
lands.

## Ordering

The constraint is not losing visibility partway through the transition. The
mitigating fact, from [#889], is that today's visibility is already conditional
and substantially inert: instrumentation does not run unless the panel is open,
and 31 `debugStats` fields are dead or structurally incapable of varying.

1. **Dead-field cleanup.** The 31 fields, their write sites, the three lying
   surfaces (`Cache: 0h / 0m` for counters only ever zeroed, the MIXED LEVELS
   banner unreachable behind a hardcoded `false`, the members table that can only
   read `uploadL? n:0 p:0`) and the `upload.resend_storm` site. Depends on
   nothing.
2. **Overlay decoupling and Dev controls.** Sever `showDebug` from the overlay
   mount; lift `ConfigTab` into `DevControls`; move the overlay toggles and the
   four session-scoped cache knobs in; drop the logging checkboxes.

   *Everything through here is reversible and loses no live capability — the
   panel still exists and still observes.*

3. **`debugStats.enabled` deleted with the recorder's landing**, at the same call
   sites, under [0049]'s CI gates. Not before: the gate and the gauges are
   largely the *same lines*, and removing the gate first would buy a window where
   the pipeline pays for instrumentation nobody reads, against a ≤100 ns/event
   contract with no assertion yet standing over it.
4. **Panel teardown.** `DebugPanel.tsx`, `DebugPanel.css`, and the emptied
   `debugStats.ts`. Health and Catalog go with it.

Two dependencies are named rather than sequenced: [0043]'s follow-up deletes the
Catalog/proxy substrate on its own schedule, and [0047]'s per-tick aggregate
table must exist before step 4 retires the counts handed to it.

## Disposition table

| Item | Fate |
| --- | --- |
| Render tab | **Absorbed** — frame/plan/upload ms, FPS are temporal |
| Cache tab, gauges | **Absorbed** — decode p50/p95, rates, queue depth and oldest age |
| Cache tab, 4 knobs | **Dev controls**, marked session-scoped |
| Orch tab, rolling 1s + cold state | **Absorbed** — rates and rebuild percentiles |
| Orch tab, active set / requests by lane and level | **Trace** — per-tick aggregates |
| Orch tab, entity-coords overlap check | **Deleted** — ad-hoc probe |
| Orch tab, `ProxyResidencyDebug` | **Deleted** — structurally zero; substrate is [0043]'s |
| Planning tab, lanes / LOD breakdown / culling funnel | **Trace** — per-tick aggregates |
| Planning tab, focal-entity inspector | **Deleted** — ad-hoc probe |
| Planning + Cache "dump → console" buttons | **Deleted** |
| Scene tab | **Deleted** — epochs and `view_query`, no ongoing consumer |
| Pick tab | **Deleted** — one-off dev probe |
| Catalog tab | **Deleted** — observes a path that cannot execute ([0043]) |
| Health tab, rows | **Deleted** — `lucida dataset health` returns the same wire type |
| Health tab, "Retry binding" | **Kept as `lucida dataset retry`**, beside its sibling read |
| Config tab | **Kept as mutation** — becomes `DevControls` |
| Logging tab, 5 category checkboxes | **Deleted** — `localStorage.debug` + reload is the interface |
| Logging tab, 6 overlay toggles | **Dev controls** |
| `DebugOverlays.tsx` (all 6) | **Kept**, decoupled from the panel |
| `setRenderRadiusPreviewTier` | **Kept** — no longer crosses a surface boundary |
| 31 dead/inert `debugStats` fields | **Deleted** |
| `debugStats.enabled` | **Deleted** with the recorder ([0049]) |
| `DebugPanel.tsx` / `.css` | **Deleted** |

## Consequences

- **The panel is gone from production builds.** It shipped there, dev-gated only
  in its two editable regions. Dev controls is dev-gated as a whole, with the
  "Reset all to defaults" exception.
- **Instrumentation stops being something you switch on by looking.** Deleting
  `debugStats.enabled` removes the coupling [#889] identified as the largest gap
  between what exists and [0049]'s destination.
- **One capability is genuinely lost, deliberately**: the uncapped
  console dumps of plans, active sets, cache contents and the pending queue.
  Nothing replaces them; the trace covers the questions they were used for, and
  the panel's own tables were row-capped at 10–12 anyway.
- **`lucida dataset retry` is new CLI surface.** Small, and it lands beside
  `dataset health`, which already shares its wire type with the surface being
  deleted.
- **A future reader finds `debug/` holding only overlays and a mutation
  surface.** That is this record's main reason to exist.

## Considered options

- **Keep the panel alongside the monitor.** Rejected: it leaves two observation
  surfaces disagreeing about the same pipeline, one of them gated on being
  watched, and preserves ten tabs of maintenance for the five of them that are
  substantially inert.
- **Fold the overlays into the monitor.** Rejected: the overlays' value is
  registration with the viewport pixels; a separate page cannot provide it.
- **Publish browser state over new wire so `lucida debug state` can carry the
  structural residue.** Rejected: new wire and new budget spend to preserve a
  gauge board with no demonstrated consumer, when the per-tick counts worth
  keeping already fit [0047]'s aggregate table.
- **Delete config-editing entirely.** Rejected: `configStore` persists to
  `localStorage` and keeps steering the planner after the editor is gone, so
  deleting the editor without deleting the store strands users with no way to
  unstick themselves.

## Related

- [Deferred](deferred.md) — unifying `CpuCacheConfig` onto `configStore`, so the
  surviving mutation surface has one lifetime rather than two.
