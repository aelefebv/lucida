# Dual Hand-off on DatasetOpened (WASM + JS)

Status: Accepted.

## Context

A `dataset_opened` broadcast carries a manifest and a fetch source. Scene state (entities, transforms, images, layouts) belongs to the WASM `Scene` ([0007](0007-wasm-scene-as-source-of-truth.md)). Fetch state (per-image wire formats, pending requests, the decode pool) belongs to JS. Each side needs a different part of the same event.

## Decision

The client hands the event to both sides, WASM first. `scene.apply_command(json)` ingests the scene state. Then JS registers the dataset in `setupFetchPipeline` (`lucida-web/src/sessionController.ts`), in this order:

1. `contentSource.registerImage` for each image and label image, so the first fetch finds its wire format.
2. Add the dataset to the datasets map, so the steps after it can read the manifest.
3. `initLayerMaps` for per-channel display state.
4. For multichannel data, one `set_channel_visible` on the last channel through WASM. This sizes the scene's per-channel settings to the channel count in the data shape, and it needs the dataset already applied in WASM.
5. `loop.addDataset`, last, because it marks the loop dirty and the next tick must see everything above.

Registration is idempotent: a dataset already in the map is skipped. The live broadcast and the join or resync snapshot both go through the same `ensureDatasetRegistered` path.

## Rejected alternatives

- WASM does everything, fetch state included. Fetch state is native to JS, and crossing the WASM boundary for every fetch detail is costly.
- JS does everything, scene state included. That reimplements `lucida-core` and breaks [0007](0007-wasm-scene-as-source-of-truth.md).
