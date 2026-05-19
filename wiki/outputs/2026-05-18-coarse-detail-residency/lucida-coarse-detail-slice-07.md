## Parent PRD

#672

## What to build

Make chunk-only coarse/detail the default path and retire proxy fallback surfaces after parity. This slice removes the old proxy model as active behavior so fallback has one source of truth: tiered chunks.

The completed slice should stop emitting proxy catalogs/requests/assets in the default path, remove or quarantine proxy-only runtime surfaces, and ensure documentation/tests no longer describe proxy fallback as the current model.

## Acceptance criteria

- [ ] Coarse/detail is the default fallback/residency path.
- [ ] The web planner stops emitting proxy requests in the default path.
- [ ] The server stops emitting proxy catalogs for the default path.
- [ ] The client stops sending proxy asset requests and uploading proxy assets in the default path.
- [ ] Worker proxy atlases/descriptors/shader fallback are deleted or isolated behind a temporary bridge that is not the default.
- [ ] Proxy debug/admin surfaces are removed or clearly marked as legacy bridge-only.
- [ ] Asset catalog/proxy availability no longer controls fallback availability for coarse/detail rendering.
- [ ] Proxy-era docs are updated or retired so `coarse`/`detail` is the documented current model.
- [ ] Tests assert that the default path does not emit asset catalogs, proxy requests, proxy uploads, or proxy planning modes.

## Blocked by

- Blocked by #674
- Blocked by #676
- Blocked by #678

## User stories addressed

- User story 6
- User story 26
- User story 27
- User story 34

## Wiki context

- systems - [[systems/subsystems/planning-domain]], [[systems/subsystems/cpu-cache]], [[systems/subsystems/upload-pipeline]], [[systems/subsystems/worker-protocol]], [[systems/subsystems/gpu-residency]], [[flows/proxy-generation]], [[flows/chunk-lifecycle]]
- decisions - [[decisions/0024-catalog-degrade-one-tier-at-a-time]], [[decisions/0025-wells-as-planning-unit]], [[decisions/0038-budgeted-proxy-gpu-residency]], [[decisions/0039-chunk-only-coarse-detail-residency]], [[decisions/0040-generated-coarse-as-derived-pyramid-levels]]
- gotchas - [[gotchas/wire-chunk-key-conventions]]
