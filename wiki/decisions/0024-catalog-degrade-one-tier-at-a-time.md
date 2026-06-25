---
created: 2026-05-14
modified: 2026-06-25
---

# Catalog Degradation Steps One Tier at a Time

Status: Superseded for the chunk-only coarse/detail path by
[[decisions/0039-chunk-only-coarse-detail-residency]]. Historical proxy-path
behavior remains documented here.

## Decision

When the asset catalog does not advertise a proxy that the desired promotion mode would use, planning degrades the mode by exactly **one tier** — never more. The tier order is `well-as-proxy` → `fields-with-proxy-fallback` → `fields-with-detail`. If the desired mode wants a `WellProxy3D` and the catalog does not advertise one, planning falls to `fields-with-proxy-fallback`. If `fields-with-proxy-fallback` then needs a `FieldProxy3D` (or parent `WellProxy3D` as standby) and neither is advertised, planning falls to `fields-with-detail`.

Tier-skipping (e.g., `well-as-proxy` → `fields-with-detail` directly) is not allowed even when both intermediate tiers' assets are unavailable. Each degrade step is recorded in `PlanStats.catalogDegradations` for telemetry.

This ADR is a *ratification* — the rule has existed in the code (in `assignModes`) and in the wiki article ([[planning-domain]] under "Invariants") since the three-tier promotion landed. It is captured here so future contributors do not relax it.

Cited in PRD #545.

## Why

The tier order respects the visual fidelity hierarchy (least to most detail). The amount of data fetched grows monotonically across tiers: `well-as-proxy` is one asset per visible channel; `fields-with-proxy-fallback` is real field detail chunks plus per-field proxies plus the parent's well proxy; `fields-with-detail` is real field detail chunks (potentially many more than the previous tier emits). Skipping a tier — for instance going `well-as-proxy` → `fields-with-detail` directly when no `WellProxy3D` exists — would mean responding to "we wanted one coarse asset" with "we'll fetch full per-field detail," an unbounded escalation in fetch cost.

The one-tier-at-a-time rule honors [[principles/planning#1-visual-smoothness-over-fetch-optimality]] (the intermediate tier serves a real visual purpose: it bridges the gap between proxy and detail with the parent well proxy as a fallback while detail loads) and [[principles/planning#2-memory-is-the-binding-constraint]] (bounded escalation prevents catalog gaps from triggering large unanticipated fetch volumes).

## Tradeoffs

- **A tier may be chosen even when its preferred asset isn't fully available.** `fields-with-proxy-fallback` is preserved when the well's proxy exists but the field proxies are missing — the well proxy can stand in. The mode chosen reflects what the *catalog* allows, not what the original size-based decision wanted.
- **Catalog-degradation telemetry is per-tier-step.** A well that would have chosen `well-as-proxy` but catalog-degrades twice (to `fields-with-proxy-fallback`, then to `fields-with-detail`) increments `catalogDegradations` by 2, not 1. Reading the telemetry requires understanding this.

## How this decision shows up in code

- `lucida-web/src/pipeline/planning/modes.ts::degradeForCatalog` — owns the one-tier-at-a-time logic; the function is called once per well group during `assignModes` (same file). It is now reached only on the legacy `coarseDetailEnabled: false` branch (`plan.ts`); the default chunk-only path (`config.ts` default `true`, per the supersession header) does not call it.
- `PlanStats.catalogDegradations` — incremented inside `degradeForCatalog` whenever a step occurs.
- Test coverage for the legacy three-tier-with-catalog degrade transitions lives in the planning test suite under `pipeline/planning/`, with stats counter assertions.

## Related

- [[principles/planning]] — the framework this decision lives within
- [[planning-domain]] — subsystem article; the "Invariants" section
- [[chunk-lifecycle]] — section 3b (promotion) and the catalog-aware degradation paragraph
- PRD #545 — the work item during which this ADR was captured
