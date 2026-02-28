# Lucida Protocol and Core Schemas

Version: 0.1 draft  
Date: 2026-02-28  
Status: First-pass protocol/schema draft based on the agreed Lucida product spec

## 1. Purpose

This document turns the Lucida product spec into concrete protocol and schema contracts.

It defines:
- identifier and revision strategy
- control-plane envelopes
- authoritative state model
- chunk key and data-plane addressing
- target, region recipe, cutout, and publish schemas
- scene file and context package schemas
- warning, error, and filter AST taxonomies

This document is intentionally implementation-oriented. Field names, invariants, and object boundaries are meant to stay stable even if the underlying transport or storage implementation evolves.

---

## 2. Design principles

1. The engine is authoritative.
2. Shared scene state and per-client view state are distinct.
3. Every meaningful object has a stable opaque ID.
4. Every authoritative change is ordered by a monotonic session revision.
5. Clients receive typed authoritative events, not generic JSON patches.
6. Payload bytes are fetched on the data plane; control-plane messages carry manifests, references, and state.
7. Schema contracts are written for four frontends at once: browser, Jupyter, CLI, and LLM control.

---

## 3. Schema conventions

### 3.1 General encoding rules

- All protocol messages are UTF-8 JSON unless explicitly marked as binary payloads on the data plane.
- All timestamps are RFC 3339 UTC strings.
- All IDs are lowercase ASCII strings.
- All integer counters are unsigned 64-bit logical values unless otherwise noted.
- Null is used only when a field is intentionally absent/unknown, not as a substitute for omitted required fields.

### 3.2 Canonical naming

- JSON field names use `snake_case`.
- Enum values use lowercase snake_case strings.
- Operation names use dot-separated namespaces, for example `view.pan`, `scene.layer_add`, `cutout.create`.

### 3.3 Required vs optional fields

In the schemas below:
- `Required` means the field MUST be present.
- `Optional` means the field MAY be omitted.
- `Nullable` means the field MAY be present with value `null`.

### 3.4 Object replacement policy

The control plane uses typed events and subtree replacement, not generic JSON Patch.

Rules:
- Initial attach sends a full `session.snapshot`.
- Subsequent events replace the smallest coherent authoritative subtree.
- If an event updates a layer, it carries the full authoritative layer object, not a diff patch.
- If an event updates a client view state, it carries the full authoritative client view subtree.

This is simpler, more robust, and easier for multiple frontends and LLMs to reason about.

---

## 4. Identifier strategy

### 4.1 Opaque ID format

All stable IDs are opaque strings with a semantic prefix plus a ULID-like sortable suffix.

Examples:
- `sess_01jmyb4v2n1f1n4a1sz6p3r8dw`
- `cli_01jmyb4wqch6kn8k9n2m4g7x3p`
- `src_01jmyb4ycx7w7z4t1k1f36svda`
- `ds_01jmyb508k5at6q2m4hfh3f8t4`
- `lay_01jmyb52cjk4w3v8rmqk9r7e9y`
- `tgt_01jmyb53k3wq2mnf1tb8v16f3e`
- `rr_01jmyb54qj4w5j00jsw2s3z8hg`
- `pub_01jmyb55k5xw8kq6jme3b8g5sd`
- `gen_01jmyb56t7r4mc0v2kq14t2txv`
- `scn_01jmyb57dpkq6j9r2yg4vab3h8`
- `lcp_01jmyb58z8y2k4q0m1g7p1zvck`

Clients MUST treat IDs as opaque strings. Prefixes are for readability and debugging only.

### 4.2 Stable identity classes

| Object | ID field |
|---|---|
| Session | `session_id` |
| Client | `client_id` |
| Source record | `source_id` |
| Dataset binding | `dataset_id` |
| Generation | `generation_id` |
| Layer | `layer_id` |
| Target | `target_id` |
| Region recipe | `recipe_id` |
| Publish batch | `publish_batch_id` |
| Scene file | `scene_id` |
| Context package | `context_package_id` |
| Token | `token_id` |

### 4.3 Generation identity

Generations use both:
- `generation_id`: globally unique opaque identifier
- `generation_seq`: monotonically increasing integer per source

Why both:
- `generation_id` is stable for references, pinning, and sharing.
- `generation_seq` is convenient for monotonic local reasoning and UI labels.

---

## 5. Revision strategy

Lucida uses layered revisions.

### 5.1 Required revision counters

#### Session-wide ordering
- `session_rev`: monotonic total order over every authoritative event emitted by the session

#### Shared scene ordering
- `scene_rev`: monotonic order over shared scene edits

#### Per-client view ordering
- `view_rev`: monotonic order over one client's authoritative view state

#### Per-layer ordering
- `layer_rev`: monotonic order over layer definition changes
- `metadata_rev`: monotonic order over metadata sidecar changes for that layer
- `write_rev`: monotonic order over sparse derived chunk publishes for that layer

#### Per-source generation ordering
- `generation_seq`: monotonic per source as described above

### 5.2 Revision usage rules

- Every authoritative event MUST include `session_rev`.
- Events that mutate shared scene state MUST include resulting `scene_rev`.
- Events that mutate one client's view state MUST include resulting `view_rev`.
- Layer upsert/update events MUST include the layer's resulting `layer_rev`, and `metadata_rev` / `write_rev` where relevant.
- Publish completion events MUST include resulting `write_rev`.

### 5.3 Preconditions

Commands MAY include preconditions:
- `if_scene_rev`
- `if_view_rev`
- `if_layer_rev`
- `if_metadata_rev`

If a precondition fails, the engine returns `stale_revision` or `precondition_failed`.

---

## 6. Permission and capability model

### 6.1 Permission classes

Lucida distinguishes three permission classes:

1. `view`
   - read shared scene state
   - read own per-client view state
   - mutate own per-client view state
   - fetch data-plane payloads

2. `control`
   - everything in `view`
   - request/steal lease
   - mutate shared scene state while holding lease
   - create/modify/delete targets while holding lease
   - publish derived chunks without lease

3. `admin`
   - everything in `control`
   - create/revoke tokens
   - change session exposure mode
   - administrative configuration

### 6.2 View and control tokens

- LAN mode defaults to open view.
- A session MAY require a `view_token` for read access.
- Shared scene edits require a `control_token` plus lease.
- Derived chunk publishing requires a `control_token` but not lease.

### 6.3 Lease semantics

The shared-scene lease is a floor-control lock.

Rules:
- At most one lease holder per session.
- Any control-token client MAY steal the lease.
- Lease changes are passive notifications.
- Lease changes MUST be audit logged.

---

## 7. Control-plane envelopes

## 7.1 Base message envelope

All control-plane messages have:

```json
{
  "message_type": "command | command_ack | event | error | heartbeat | session.snapshot",
  "schema_version": "lucida-proto-0.1",
  "session_id": "sess_...",
  "sent_at": "2026-02-28T21:15:00Z"
}
```

### 7.2 Command envelope

```json
{
  "message_type": "command",
  "schema_version": "lucida-proto-0.1",
  "session_id": "sess_...",
  "request_id": "req_...",
  "client_id": "cli_...",
  "client_seq": 1842,
  "op": "view.pan",
  "scope": "client_view | scene_shared | admin",
  "requires_lease": false,
  "args": {},
  "preconditions": {
    "if_scene_rev": 120,
    "if_view_rev": 93,
    "if_layer_rev": 14,
    "if_metadata_rev": 8
  },
  "idempotency_key": "optional-string",
  "sent_at": "2026-02-28T21:15:00Z"
}
```

Field rules:
- `request_id`: Required. Unique per command message.
- `client_seq`: Required. Monotonic per client.
- `scope`: Required.
- `requires_lease`: Required, must match operation metadata.
- `preconditions`: Optional.
- `idempotency_key`: Optional; useful for retry-safe commands.

### 7.3 Command ack envelope

```json
{
  "message_type": "command_ack",
  "schema_version": "lucida-proto-0.1",
  "session_id": "sess_...",
  "request_id": "req_...",
  "client_id": "cli_...",
  "client_seq": 1842,
  "accepted": true,
  "resulting_session_rev": 991,
  "resulting_scene_rev": 121,
  "resulting_view_rev": 94,
  "warnings": ["computed_at_lod"],
  "sent_at": "2026-02-28T21:15:00Z"
}
```

Rules:
- Ack confirms receipt and acceptance, not necessarily full downstream completion of ingest/publish jobs.
- Long-running actions produce later events for completion/progress.

### 7.4 Error envelope

```json
{
  "message_type": "error",
  "schema_version": "lucida-proto-0.1",
  "session_id": "sess_...",
  "request_id": "req_...",
  "client_id": "cli_...",
  "client_seq": 1842,
  "op": "scene.layer_add",
  "code": "lease_required",
  "message": "Shared scene edit requires lease.",
  "retryable": true,
  "details": {
    "current_lease_holder_client_id": "cli_...",
    "required_scope": "scene_shared"
  },
  "sent_at": "2026-02-28T21:15:00Z"
}
```

#### Standard error codes

- `validation_error`
- `unknown_op`
- `permission_denied`
- `invalid_token`
- `lease_required`
- `precondition_failed`
- `stale_revision`
- `not_found`
- `source_unavailable`
- `generation_unavailable`
- `generation_build_incomplete`
- `metadata_mismatch`
- `publish_conflict`
- `unsupported_codec`
- `quota_exceeded`
- `internal_error`

### 7.5 Event envelope

```json
{
  "message_type": "event",
  "schema_version": "lucida-proto-0.1",
  "session_id": "sess_...",
  "session_rev": 992,
  "event_type": "scene.layer_upsert",
  "payload": {},
  "emitted_at": "2026-02-28T21:15:01Z"
}
```

Rules:
- Every event is authoritative.
- `session_rev` totally orders all events.
- The payload shape depends on `event_type`.

### 7.6 Snapshot envelope

On attach or explicit resync:

```json
{
  "message_type": "session.snapshot",
  "schema_version": "lucida-proto-0.1",
  "session_id": "sess_...",
  "session_rev": 992,
  "snapshot": {
    "session": {},
    "shared_scene": {},
    "client_view": {},
    "permissions": {},
    "lease_state": {},
    "client_roster": [],
    "warnings": []
  },
  "emitted_at": "2026-02-28T21:15:01Z"
}
```

---

## 8. Event taxonomy

Lucida events are typed. There is no generic patch event.

### 8.1 Session / lease events

- `session.client_joined`
- `session.client_left`
- `lease.changed`
- `permissions.updated`

### 8.2 Shared scene events

- `scene.replaced`
- `scene.source_upsert`
- `scene.source_remove`
- `scene.dataset_upsert`
- `scene.dataset_remove`
- `scene.layer_upsert`
- `scene.layer_remove`
- `scene.layer_order_replace`
- `scene.target_upsert`
- `scene.target_remove`
- `scene.defaults_replace`
- `scene.overview_policy_replace`

### 8.3 Per-client view events

- `view.replaced`
- `view.updated`
- `view.warning_set`
- `view.warning_clear`

### 8.4 Source / generation / ingest events

- `source.generation_detected`
- `source.generation_started`
- `source.generation_progress`
- `source.generation_ready`
- `source.generation_failed`

### 8.5 Metadata and label events

- `metadata.updated`
- `metadata.filter_result_ready`
- `metadata.filter_result_failed`
- `labels.mapping_epoch_changed`

### 8.6 Derived layer / publish events

- `publish.started`
- `publish.completed`
- `publish.failed`

### 8.7 Audit events

- `audit.entry`

---

## 9. Authoritative state model

## 9.1 Session object

```json
{
  "session_id": "sess_...",
  "name": "main-lab-session",
  "schema_version": "lucida-proto-0.1",
  "engine_version": "0.1.0",
  "created_at": "2026-02-28T21:00:00Z",
  "session_rev": 992,
  "scene_rev": 121,
  "lease_state": {},
  "exposure_mode": {
    "lan_enabled": true,
    "view_mode": "open | token_required"
  }
}
```

## 9.2 LeaseState

```json
{
  "lease_holder_client_id": "cli_...",
  "lease_holder_label": "alice-laptop",
  "acquired_at": "2026-02-28T21:02:00Z",
  "stealable": true,
  "expires_at": null
}
```

## 9.3 ClientRosterEntry

```json
{
  "client_id": "cli_...",
  "label": "alice-laptop",
  "permission_class": "view | control | admin",
  "connected_at": "2026-02-28T21:01:00Z",
  "last_seen_at": "2026-02-28T21:15:00Z",
  "is_lease_holder": true
}
```

## 9.4 SharedSceneState

```json
{
  "scene_rev": 121,
  "scene_id": "scn_...",
  "name": "experiment-42-live",
  "mode": "live | pinned",
  "sources": {
    "src_...": {}
  },
  "datasets": {
    "ds_...": {}
  },
  "layers": {
    "lay_...": {}
  },
  "layer_order": ["lay_...", "lay_..."],
  "targets": {
    "tgt_...": {}
  },
  "overview_policy": {},
  "shared_defaults": {},
  "warnings": []
}
```

### 9.4.1 Scene mode semantics

- `live`: scene MAY reference `@working` dataset bindings.
- `pinned`: scene MUST reference concrete generations only.

## 9.5 SourceRecord

A source is an external mutable data location.

```json
{
  "source_id": "src_...",
  "name": "plateA-wellB03",
  "uri": "file:///data/plateA/B03.ome.tif",
  "source_kind": "tiff | bigtiff | zarr | ome_zarr | n5 | other",
  "watch_enabled": true,
  "watch_mode": "watcher_only",
  "status": "idle | watching | building | error",
  "latest_working_generation_id": "gen_...",
  "latest_working_generation_seq": 43,
  "stability_window": {
    "debounce_seconds": 2.0,
    "single_file_verify_ms": 200
  },
  "source_metadata": {
    "original_axis_order": ["t", "c", "z", "y", "x"],
    "canonical_axis_order": ["t", "c", "z", "y", "x"],
    "shape": {
      "t": 12,
      "c": 5,
      "z": 400,
      "y": 20480,
      "x": 20480
    },
    "dtype": "uint16",
    "calibration": {
      "status": "calibrated | uncalibrated | user_overridden",
      "spacing": {"x": 0.108, "y": 0.108, "z": 0.5},
      "units": "um"
    }
  },
  "warnings": []
}
```

## 9.6 DatasetBinding

A dataset binding is a scene-level reference to either a source-backed or Lucida-derived dataset.

```json
{
  "dataset_id": "ds_...",
  "name": "plateA-B03-working",
  "dataset_kind": "source | derived",
  "generation_ref": {
    "mode": "working | pinned",
    "generation_id": null
  },
  "resolved_generation_id": "gen_...",
  "resolved_generation_seq": 43,
  "source_id": "src_...",
  "canonical_axes": ["t", "c", "z", "y", "x"],
  "extra_axes": [],
  "shape": {
    "t": 12,
    "c": 5,
    "z": 400,
    "y": 20480,
    "x": 20480
  },
  "dtype": "uint16",
  "channel_block_size": 4,
  "representations": {
    "tile2d": {
      "available_lods": [0, 1, 2, 3, 4],
      "default_tile_shape": [512, 512]
    },
    "brick3d": {
      "available_lods": [0, 1, 2],
      "default_brick_shape": [64, 64, 64]
    },
    "preview2d": {
      "available_lods": [3, 4, 5]
    }
  },
  "calibration": {
    "status": "calibrated | uncalibrated | user_overridden",
    "spacing": {"x": 0.108, "y": 0.108, "z": 0.5},
    "units": "um"
  },
  "affine_world_from_index": {
    "matrix": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
    "space": "world"
  },
  "channel_table": {
    "channel_count": 5,
    "channels": [
      {"index": 0, "name": "DAPI", "metadata": {"stain": "DAPI"}},
      {"index": 1, "name": "FITC", "metadata": {}}
    ]
  },
  "warnings": []
}
```

#### Dataset binding rules

- `generation_ref.mode = working` means the dataset follows the latest working generation for its source.
- `generation_ref.mode = pinned` means `generation_id` MUST be set.
- For derived datasets, `source_id` MAY be null and dependency metadata MUST be provided elsewhere.

## 9.7 Layer object

All layers share a common envelope.

```json
{
  "layer_id": "lay_...",
  "name": "nuclei",
  "kind": "image | labels | points",
  "role": "base | derived",
  "dataset_id": "ds_...",
  "layer_rev": 18,
  "metadata_rev": 2,
  "write_rev": 0,
  "blend_mode": "alpha_over | additive | max | screen",
  "opacity_default": 1.0,
  "visible_default": true,
  "affine_world_from_index": {
    "matrix": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
    "space": "world"
  },
  "rendering_defaults": {},
  "warnings": []
}
```

### 9.7.1 ImageLayer extension

```json
{
  "kind": "image",
  "rendering_defaults": {
    "visible_channels": [0, 2, 4],
    "channel_settings": {
      "0": {"contrast_limits": [0, 1200], "gamma": 1.0, "colormap": "gray"},
      "2": {"contrast_limits": [100, 2000], "gamma": 1.0, "colormap": "green"},
      "4": {"contrast_limits": [50, 1500], "gamma": 1.0, "colormap": "magenta"}
    },
    "interpolation": "linear"
  }
}
```

### 9.7.2 LabelsLayer extension

```json
{
  "kind": "labels",
  "label_index": {
    "mapping_epoch": 3,
    "id_domain": "dense",
    "sidecar_ref": {
      "storage_kind": "sqlite",
      "uri": "lucida://sidecars/labels/lay_.../metadata.sqlite"
    }
  },
  "rendering_defaults": {
    "outline_enabled": true,
    "outline_thickness": 1.5,
    "unknown_policy": "show",
    "color_mode": "hashed_id | class_palette"
  }
}
```

### 9.7.3 PointsLayer extension

```json
{
  "kind": "points",
  "points_ref": {
    "storage_kind": "sqlite | parquet | lucida_internal",
    "uri": "lucida://points/lay_..."
  },
  "rendering_defaults": {
    "symbol": "circle",
    "size": 4.0,
    "color_mode": "fixed | metadata_field"
  }
}
```

### 9.7.4 Derived layer extension

Derived layers are represented as ordinary layers with role `derived` plus dependency metadata.

```json
{
  "role": "derived",
  "dependency": {
    "base_layer_id": "lay_...",
    "base_generation_id": "gen_...",
    "policy": "pinned_to_base_generation | follow_working",
    "rebase_allowed": false
  },
  "sparse_coverage": {
    "missing_chunks_semantics": "transparent",
    "coverage_overlay_available": true
  },
  "write_acl": {
    "mode": "any_control_token | allow_list",
    "allowed_token_ids": []
  }
}
```

## 9.8 PerClientViewState

```json
{
  "client_id": "cli_...",
  "view_rev": 94,
  "view_mode": "2d | 3d",
  "active_layer_id": "lay_...",
  "camera": {
    "projection": "orthographic | perspective",
    "target_world": [123.4, 567.8, 12.0],
    "position_world": [123.4, 567.8, 212.0],
    "up_world": [0, -1, 0],
    "zoom": 8.5,
    "rotation_quat": [0, 0, 0, 1]
  },
  "indices": {
    "extra_axes": {},
    "t": 0,
    "z": 120,
    "visible_channels": [0, 2, 4]
  },
  "slab": {
    "enabled": false,
    "thickness_voxels": 1
  },
  "rendering": {
    "per_layer_overrides": {
      "lay_...": {
        "opacity": 1.0,
        "interpolation": "linear",
        "channel_settings": {},
        "label_filter": null,
        "outline_thickness": 1.5
      }
    }
  },
  "warnings": []
}
```

### 9.8.1 Per-client rendering default rule

Rendering knobs are per-client by default. An explicit scene command is required to promote them to shared defaults.

---

## 10. Warning taxonomy

Warnings are normalized objects, not free-form strings.

```json
{
  "warning_code": "uncalibrated_layer",
  "severity": "info | warning | error",
  "scope": "scene | layer | client_view | context_package",
  "message": "Layer has unknown physical calibration.",
  "details": {}
}
```

### 10.1 Standard warning codes

- `uncalibrated_layer`
- `mixed_calibration_overlay`
- `stale_derived_dependency`
- `incomplete_label_index`
- `computed_at_lod`
- `generation_build_incomplete`
- `metadata_out_of_sync`
- `filter_result_partial`
- `overview_layer_missing`
- `layer_not_visible_at_requested_detail`

---

## 11. Chunk key and data-plane addressing

## 11.1 ChunkKey object

```json
{
  "dataset_id": "ds_...",
  "generation_id": "gen_...",
  "layer_id": "lay_...",
  "representation": "tile2d | brick3d | preview2d",
  "lod": 0,
  "index_key": {
    "extra_indices": {
      "position": 3,
      "round": 1
    },
    "t": 0,
    "z": 120
  },
  "c0": 0,
  "coords": {
    "ty": 17,
    "tx": 42
  }
}
```

### 11.1.1 Representation-specific rules

For `tile2d`:
- `index_key` MUST include all fixed non-spatial axes, including `t` and `z`.
- `coords` MUST be `{ty, tx}`.
- `c0` MUST be present for image layers and omitted for labels/preview composite payloads.

For `brick3d`:
- `index_key` MUST include all fixed non-spatial axes except `z`.
- `coords` MUST be `{bz, by, bx}`.
- `c0` MUST be present for image layers and omitted for labels.

For `preview2d`:
- `index_key` SHOULD follow tile semantics when the preview is per-plane.
- `c0` MAY be omitted if preview is a precomposited view.

### 11.1.2 Canonical `index_key` encoding

In canonical JSON form, `index_key` is a named object.

Rules:
- `extra_indices` uses canonical extra-axis names.
- All fixed non-spatial axes for the payload MUST be explicitly present.
- Axes of length 1 MUST still be present in canonical keys if they are part of the dataset shape.

### 11.1.3 Canonical string form

Canonical string form is deterministic and URL-safe:

- extras are encoded in canonical axis order as `axis=value` pairs joined by `;`
- then `t=value`
- then `z=value` for tiles only

Examples:
- tile: `position=3;round=1;t=0;z=120`
- brick: `position=3;round=1;t=0`

### 11.1.4 Canonical URL path form

Recommended path layout:

```text
/v1/data/{dataset_id}/{generation_id}/{layer_id}/{representation}/lod/{lod}/idx/{index_key}/c0/{c0}/chunk/{coord_key}
```

Examples:

```text
/v1/data/ds_.../gen_.../lay_.../tile2d/lod/0/idx/position=3;round=1;t=0;z=120/c0/0/chunk/y=17;x=42

/v1/data/ds_.../gen_.../lay_.../brick3d/lod/2/idx/position=3;round=1;t=0/c0/4/chunk/z=4;y=9;x=11
```

### 11.1.5 Payload descriptor

Control-plane manifests and cutout responses refer to chunk payloads using:

```json
{
  "chunk_key": {},
  "url": "/v1/data/...",
  "byte_length": 532180,
  "uncompressed_byte_length": 1048576,
  "codec": "zstd",
  "dtype": "uint16",
  "shape": [4, 512, 512],
  "checksum_sha256": "hex"
}
```

---

## 12. Filter DSL AST

The label metadata filter DSL is a JSON AST.

## 12.1 Grammar

A filter node is one of:

### Boolean combinators

```json
{"op": "and", "args": [<node>, <node>]}
{"op": "or",  "args": [<node>, <node>]}
{"op": "not", "arg": <node>}
```

### Comparisons

```json
{"op": "cmp", "field": "score", "cmp": ">=", "value": 0.8}
```

Allowed `cmp` values:
- `=`
- `!=`
- `<`
- `<=`
- `>`
- `>=`

### Set membership

```json
{"op": "in", "field": "class", "values": ["mitosis", "apoptosis"]}
```

### String operations

```json
{"op": "contains", "field": "name", "value": "mito", "case_sensitive": false}
{"op": "starts_with", "field": "barcode", "value": "A03", "case_sensitive": false}
```

### Null checks

```json
{"op": "is_null", "field": "score"}
{"op": "is_not_null", "field": "score"}
```

## 12.2 Filter request wrapper

```json
{
  "layer_id": "lay_...",
  "metadata_rev": 12,
  "unknown_policy": "show | hide",
  "expr": {
    "op": "and",
    "args": [
      {"op": "cmp", "field": "score", "cmp": ">=", "value": 0.8},
      {"op": "in", "field": "class", "values": ["positive", "uncertain"]}
    ]
  }
}
```

## 12.3 Filter result object

```json
{
  "layer_id": "lay_...",
  "metadata_rev": 12,
  "mapping_epoch": 3,
  "unknown_policy": "show",
  "stats": {
    "matched_count": 184203,
    "dense_id_count": 2400000,
    "has_unknown_rows": true
  },
  "visibility_mask": {
    "encoding": "raw_bitset | roaring | rle",
    "num_dense_ids": 2400000,
    "byte_length": 300000,
    "url": "/v1/filter-results/..."
  }
}
```

---

## 13. Target schema

```json
{
  "target_id": "tgt_...",
  "name": "mitotic-cluster-01",
  "created_at": "2026-02-28T21:10:00Z",
  "created_by_client_id": "cli_...",
  "updated_at": "2026-02-28T21:12:00Z",
  "base_layer_id_default": "lay_...",
  "navigation": {
    "view_mode": "2d | 3d",
    "camera": {
      "projection": "orthographic | perspective",
      "target_world": [123.4, 567.8, 12.0],
      "position_world": [123.4, 567.8, 212.0],
      "up_world": [0, -1, 0],
      "zoom": 8.5,
      "rotation_quat": [0, 0, 0, 1]
    },
    "indices": {
      "extra_axes": {},
      "t": 0,
      "z": 120,
      "visible_channels": [0, 2, 4]
    },
    "slab": {
      "enabled": false,
      "thickness_voxels": 1
    }
  },
  "analysis_roi": {
    "mode": "viewport | fixed_box",
    "world_bounds": {
      "x_min": 100.0,
      "x_max": 200.0,
      "y_min": 300.0,
      "y_max": 500.0,
      "z_min": 11.5,
      "z_max": 12.5
    },
    "fixed_box_world_size": null
  },
  "defaults": {
    "lod_policy": "full | match_view | explicit",
    "lod_value": null,
    "halo": {
      "unit": "chunks | world",
      "value": [1, 1, 0]
    },
    "publish_extent": "halo | core",
    "channel_policy": {
      "mode": "visible | explicit | all",
      "channels": null
    },
    "z_mode": "single_plane | slab"
  },
  "tags": ["prototype", "candidate"]
}
```

### Target rules

- Targets are shared scene objects by default.
- Creating/updating/deleting targets requires lease.
- Jumping to a target only mutates per-client view state and does not require lease.
- Cutout requests may override target defaults without mutating the target.

---

## 14. RegionRecipe schema

A RegionRecipe is the deterministic description of a cutout.

## 14.1 RegionRecipe object

```json
{
  "recipe_id": "rr_...",
  "created_at": "2026-02-28T21:20:00Z",
  "created_by_client_id": "cli_...",
  "base_layer_id": "lay_...",
  "dataset_id": "ds_...",
  "generation_id": "gen_...",
  "representation": "tile2d | brick3d",
  "cutout_mode": "plane | slab | volume",
  "lod_requested": "full | match_view | 2",
  "lod_resolved": 0,
  "channel_policy": {
    "mode": "visible | explicit | all",
    "channels": [0, 2, 4],
    "resolved_channel_blocks": [0, 4]
  },
  "index_selection": {
    "extra_axes": {},
    "t": 0,
    "z": 120,
    "slab_thickness_voxels": 1
  },
  "core_roi": {
    "world_bounds": {
      "x_min": 100.0,
      "x_max": 200.0,
      "y_min": 300.0,
      "y_max": 500.0,
      "z_min": 12.0,
      "z_max": 12.0
    },
    "index_bounds": {
      "x_min": 1000,
      "x_max": 2000,
      "y_min": 3000,
      "y_max": 5000,
      "z_min": 120,
      "z_max": 120
    },
    "chunk_bounds": {
      "tx_min": 1,
      "tx_max": 4,
      "ty_min": 5,
      "ty_max": 9
    }
  },
  "halo": {
    "unit": "chunks | world",
    "value": [1, 1, 0]
  },
  "halo_roi": {
    "world_bounds": {},
    "index_bounds": {},
    "chunk_bounds": {}
  },
  "geometry": {
    "affine_world_from_index": {
      "matrix": [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
      "space": "world"
    }
  },
  "resolved_chunk_manifest": {
    "core_chunks": [],
    "halo_only_chunks": []
  },
  "warnings": []
}
```

## 14.2 Recipe design choice

A RegionRecipe includes both:
- compact geometry descriptor (`core_roi`, `halo`, `index_selection`, `lod_resolved`)
- explicit resolved chunk manifest (`resolved_chunk_manifest`)

This supports both deterministic recomputation and exact reproducibility.

## 14.3 Manifest entries

Manifest entries use `ChunkPayloadDescriptor` plus role metadata:

```json
{
  "chunk_key": {},
  "role": "core | halo_only",
  "url": "/v1/data/...",
  "dtype": "uint16",
  "shape": [4, 512, 512],
  "checksum_sha256": "hex"
}
```

---

## 15. Cutout request and response schemas

## 15.1 CutoutRequest

```json
{
  "request_id": "req_...",
  "source": {
    "mode": "current_view | target | recipe",
    "target_id": "tgt_...",
    "recipe_id": null
  },
  "base_layer_id_override": null,
  "representation": "tile2d | brick3d",
  "lod": "full | match_view | 2",
  "channel_policy": {
    "mode": "visible | explicit | all",
    "channels": null
  },
  "halo": {
    "unit": "chunks | world",
    "value": [1, 1, 0]
  },
  "plane_or_volume": {
    "mode": "plane | slab | volume",
    "slab_thickness_voxels": 1
  },
  "materialization_mode": "chunk_refs | local_mount | dense_adapter"
}
```

### Cutout request rules

- `lod = full` resolves to LOD0.
- `lod = match_view` resolves to the effective currently rendered LOD.
- `lod = integer` resolves to that explicit LOD.
- Default is `full`.
- Default channels are visible channels.
- 2D default is `plane`; slab is requestable.
- 3D default is `volume` around camera target or target ROI.

## 15.2 CutoutResponse

```json
{
  "request_id": "req_...",
  "recipe": {},
  "materialization": {
    "mode": "chunk_refs | local_mount | dense_adapter",
    "chunk_refs": [
      {
        "chunk_key": {},
        "url": "/v1/data/...",
        "dtype": "uint16",
        "shape": [4, 512, 512],
        "checksum_sha256": "hex"
      }
    ],
    "local_mount": null,
    "dense_adapter": {
      "available": true,
      "axis_order": ["c", "y", "x"],
      "notes": "Client-side adapter may densify fetched chunk refs."
    }
  },
  "stats": {
    "chunk_count_core": 16,
    "chunk_count_halo_only": 8,
    "estimated_uncompressed_bytes": 33554432
  }
}
```

### Materialization policy

Default transport style is references/manifests, not inline bytes.

Inline bytes MAY be allowed for small/local cases in future, but the normative default is:
- control plane returns references and descriptors
- bytes are fetched over the data plane

---

## 16. Derived publish schemas

## 16.1 PublishBatch

```json
{
  "publish_batch_id": "pub_...",
  "created_at": "2026-02-28T21:25:00Z",
  "created_by_client_id": "cli_...",
  "recipe_id": "rr_...",
  "target_layer": {
    "mode": "overwrite_existing | create_new",
    "layer_id": "lay_...",
    "name_if_new": null,
    "kind": "image | labels | points"
  },
  "dependency": {
    "base_layer_id": "lay_...",
    "base_generation_id": "gen_...",
    "policy": "pinned_to_base_generation | follow_working"
  },
  "representation": "tile2d | brick3d",
  "lod": 0,
  "publish_extent": "halo | core",
  "payload_mode": "external_refs | inline_bytes",
  "chunks": [
    {
      "derived_chunk_key": {},
      "source_role": "core | halo_only",
      "payload_ref": {
        "url": "file:///tmp/result_chunk_001.bin",
        "codec": "zstd",
        "dtype": "float32",
        "shape": [4, 512, 512],
        "checksum_sha256": "hex"
      },
      "inline_bytes_base64": null,
      "stats": {
        "min": 0.0,
        "max": 0.98,
        "mean": 0.02,
        "nonzero_count": 120940
      }
    }
  ],
  "notes": "prototype threshold pass"
}
```

### Publish batch rules

- Publishing is chunk-aligned only.
- Default `publish_extent` is `halo`.
- Optional `publish_extent = core` publishes only chunks intersecting the non-halo ROI.
- `payload_mode = external_refs` is the normative default.
- `inline_bytes` is allowed only when explicitly supported by the implementation.
- Missing chunks remain transparent/no contribution.

## 16.2 Publish completion event payload

```json
{
  "publish_batch_id": "pub_...",
  "layer_id": "lay_...",
  "write_rev": 7,
  "chunk_count_written": 24,
  "lod": 0,
  "representation": "tile2d",
  "completed_at": "2026-02-28T21:25:05Z"
}
```

## 16.3 Conflict semantics

Derived chunk publishing uses last-write-wins per chunk.

Tie-break order:
1. resulting `write_rev`
2. server acceptance time
3. request ID lexical tie-break if required

Every overwrite MUST be audit logged.

---

## 17. Scene file schema

Scene files represent interactive configuration, not necessarily a captured view.

```json
{
  "scene_id": "scn_...",
  "scene_file_version": "lucida-scene-0.1",
  "created_at": "2026-02-28T21:30:00Z",
  "name": "experiment-42-scene",
  "mode": "live | pinned",
  "sources": {
    "src_...": {
      "uri": "file:///data/plateA/B03.ome.tif",
      "source_kind": "ome_tiff"
    }
  },
  "datasets": {
    "ds_...": {
      "source_id": "src_...",
      "generation_ref": {
        "mode": "working | pinned",
        "generation_id": null
      }
    }
  },
  "layers": {
    "lay_...": {}
  },
  "layer_order": ["lay_..."],
  "targets": {
    "tgt_...": {}
  },
  "overview_policy": {},
  "shared_defaults": {},
  "initial_view_suggestion": {
    "target_id": "tgt_..."
  },
  "export_warnings": []
}
```

### Scene file boundary

Scene files MUST include:
- sources/dataset references
- shared scene state sufficient to recreate the interactive configuration

Scene files SHOULD NOT require embedding rendered images.

Scene files MAY include an initial view suggestion, but MUST NOT treat one client view as authoritative shared state.

---

## 18. Context package schema

Context packages represent "what I saw" and are LLM-friendly.

## 18.1 Context package object

```json
{
  "context_package_id": "lcp_...",
  "context_package_version": "lucida-context-0.1",
  "captured_at": "2026-02-28T21:35:00Z",
  "captured_from": {
    "session_id": "sess_...",
    "client_id": "cli_..."
  },
  "capture_mode": "thin | thick_minimal",
  "scene_snapshot": {
    "scene_rev": 121,
    "shared_scene": {}
  },
  "client_view_snapshot": {
    "view_rev": 94,
    "client_view": {}
  },
  "rendered_assets": {
    "main_view": {
      "path": "assets/main_view.png",
      "width": 1600,
      "height": 900
    },
    "minimap": {
      "path": "assets/minimap.png",
      "width": 320,
      "height": 320
    }
  },
  "capture_details": {
    "effective_lod_by_layer": {
      "lay_...": 2
    },
    "warnings": [
      {
        "warning_code": "computed_at_lod",
        "severity": "warning",
        "scope": "layer",
        "message": "Derived layer shown at LOD2.",
        "details": {"layer_id": "lay_...", "lod": 2}
      }
    ]
  },
  "data_references": {
    "datasets": {
      "ds_...": {
        "generation_id": "gen_..."
      }
    }
  },
  "llm_affordances": {
    "command_schema_refs": ["schemas/commands.json"],
    "summary": {
      "active_layers": ["lay_..."],
      "visible_channels": [0, 2, 4]
    }
  },
  "embedded_payloads": {
    "chunk_manifests": [],
    "chunk_payloads": []
  }
}
```

### 18.2 Thin vs thick-minimal

- `thin`: includes images, state, refs, warnings, and rehydration metadata
- `thick_minimal`: additionally includes the minimal tiles/bricks needed to reproduce the captured visualization offline

### 18.3 Context package boundary

Context packages MUST include:
- rendered viewport image
- minimap image
- exact generation references
- sufficient view + scene metadata to reopen the same visualization
- warning objects
- effective LOD details when relevant

---

## 19. Canonical command families

This document does not fully enumerate every command, but the command namespace is expected to look like this.

### 19.1 Client view commands

- `view.pan`
- `view.zoom`
- `view.rotate`
- `view.set_indices`
- `view.set_channels`
- `view.set_active_layer`
- `view.set_rendering_overrides`
- `view.jump_to_target`

### 19.2 Shared scene commands

- `scene.add_source`
- `scene.add_dataset_binding`
- `scene.layer_add`
- `scene.layer_remove`
- `scene.layer_reorder`
- `scene.layer_set_defaults`
- `scene.target_upsert`
- `scene.target_remove`
- `scene.set_overview_policy`
- `scene.promote_client_rendering_defaults`

### 19.3 Cutout / recipe / publish commands

- `cutout.create`
- `cutout.materialize`
- `recipe.save`
- `publish.create_layer`
- `publish.write_chunks`

### 19.4 Metadata / labels commands

- `labels.filter_apply`
- `labels.filter_clear`
- `labels.set_unknown_policy`

### 19.5 Lease / auth commands

- `lease.request`
- `lease.steal`
- `token.create`
- `token.revoke`

---

## 20. Recommended validation rules

### 20.1 Shared scene commands

If `scope = scene_shared` and `requires_lease = true`:
- reject unless client has control permission and currently holds the lease

### 20.2 Derived publish commands

If `op = publish.write_chunks`:
- require control permission
- do not require lease
- validate layer ACL if present
- validate chunk alignment against target representation and LOD
- validate payload dtype/channel count against target derived layer schema

### 20.3 RegionRecipe validation

A RegionRecipe is valid only if:
- referenced `base_layer_id` exists
- referenced `generation_id` is resolved and available or explicitly marked build-incomplete
- all chunk keys lie within dataset bounds at `lod_resolved`
- channel blocks cover the requested channels

### 20.4 Context package validation

A Context Package is valid only if:
- rendered assets exist
- all referenced datasets include exact generation IDs
- warnings are normalized warning objects
- effective LODs are recorded for any layer not shown at full available detail

---

## 21. Open implementation choices (non-blocking)

These are deliberately left as implementation choices, not schema blockers:
- control-plane transport selection (WebSocket vs WebTransport)
- whether data-plane URLs are engine-served or static-object-backed in a given deployment
- exact binary header layout for payload bytes
- exact compression libraries used client-side to support zstd/lz4

The JSON object boundaries and invariants in this document are intended to remain stable across those choices.
