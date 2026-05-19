## Parent PRD

#672

## What to build

Flip the new coarse/detail path on by default and retire proxy fallback from
active behavior after parity. This is HITL because it should only land after
manual/browser smoke confirms representative single-image and plate behavior.

## Acceptance criteria

- [ ] Default path uses chunk-only coarse/detail.
- [ ] Source-backed arbitrary chunk shapes and generated coarse both satisfy the
      default-flip criteria from the PRD.
- [ ] Planner default path emits no proxy requests or proxy planning modes.
- [ ] Server default path no longer requires proxy catalogs for fallback.
- [ ] Client default path sends no proxy asset requests/uploads.
- [ ] Worker default path has no proxy shader fallback or proxy descriptor use.
- [ ] Any remaining proxy code is unreachable legacy with a tracked deletion
      path, or is deleted outright.
- [ ] Tests assert no proxy catalogs, proxy requests, proxy uploads, proxy
      planning modes, or proxy shader fallback in the default path.
- [ ] Manual/browser smoke covers representative single-image and plate datasets
      before merge.

## Blocked by

- Blocked by #682
- Blocked by #683
- Blocked by #684
- Blocked by #685
- Blocked by #686
- Blocked by #687
- Blocked by #688

## User stories addressed

- User story 6
- User story 27
- User story 34

## Wiki context

- systems - [[systems/subsystems/planning-domain]], [[systems/subsystems/cpu-cache]], [[systems/subsystems/upload-pipeline]], [[systems/subsystems/worker-protocol]], [[systems/subsystems/gpu-residency]], [[flows/proxy-generation]], [[flows/chunk-lifecycle]]
- decisions - [[decisions/0024-catalog-degrade-one-tier-at-a-time]], [[decisions/0025-wells-as-planning-unit]], [[decisions/0038-budgeted-proxy-gpu-residency]], [[decisions/0039-chunk-only-coarse-detail-residency]], [[decisions/0041-clean-two-source-chunk-tier-renderer]]
- gotchas - [[gotchas/wire-chunk-key-conventions]]
