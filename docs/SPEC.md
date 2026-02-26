# LLM‑First N‑Dimensional Image Viewer (Lightweight Napari‑style) — Technical Specification

Primary goal: a small, fast, agent‑driven N‑D viewer that can open large microscopy datasets (OME‑Zarr), navigate in 2D and 3D, and produce reproducible “snapshots” plus machine‑readable manifests.

---

## 1. Summary

This project delivers a **headless “viewer server”** with a **JSON‑first control surface** designed for LLM agents. The agent can:

- Open large multiscale OME‑Zarr datasets (local or remote).
- Navigate orthogonal 2D planes with pan/zoom and slicing (XY/XZ/YZ; slab / MIP / mean).
- Navigate in 3D with arcball and optional free‑fly, and render volume views (MIP and emission‑absorption).
- Generate **single snapshots** and **multi‑snapshot “render packs”** (overview grids, multi‑angle views, channel grids), with an explicit **manifest** that ties pixels to an exact, serialized view state.
- Query numeric facts (probe values, histograms, percentiles, line profiles) so the agent is not limited to pixels.

The design is **API‑first**; a minimal CLI and a thin Python client wrap the same API.

---

## 2. Design Principles

### 2.1 LLM‑First API
- Everything is controllable via a small set of stable verbs (open, set dim, set camera, render, probe, stats).
- Viewer state is **fully serializable** as JSON (**ViewState**). Rendering should be reproducible from ViewState alone.
- All operations return structured responses; rendering returns an image artifact plus metadata (LOD used, dims, timings, completion).

### 2.2 Lightweight Core
- Avoid a large plugin system in the MVP.
- Minimize GUI dependencies; headless mode is first‑class.
- Keep feature set focused on navigation + inspection + snapshotting.

### 2.3 Performance on Chunked Multiscale Data
- Treat OME‑Zarr pyramids as the primary storage format.
- Implement explicit chunk caching (CPU and optional GPU), fixed memory budgets, and prefetch for pan/zoom.
- Progressive rendering should be supported (draft first, then refine).

### 2.4 Deterministic State & Provenance
- Provide **state_hash** computed from canonicalized ViewState JSON.
- Provide **state_version** monotonic integer for ETag-like behavior.
- Render artifacts must include a manifest describing exact state and any patch applied.

---

## 3. Scope

### 3.1 In‑Scope (MVP → v1)
- Open OME‑Zarr (local + remote via fsspec-like URIs).
- Read axes metadata: (T, C, Z, Y, X) + generic axes.
- 2D viewing: XY/XZ/YZ; slice index; slab thickness; MIP/mean/single.
- 2D pan/zoom; optional 2D rotation (can be deferred).
- Layer stack (minimal): ImageLayer; optional LabelLayer.
- Snapshot rendering: PNG (required), JPEG/WEBP optional.
- Render packs (overview presets).
- Numeric inspection: probe value at coord; histograms/percentiles for region; line profiles.
- Export/import ViewState.
- Capabilities endpoint for backend detection (GPU availability, supported modes/presets).

### 3.2 Out‑of‑Scope (initial)
- Full napari-like plugin ecosystem.
- Editing/painting/segmentation authoring tools.
- Large mesh rendering / heavy 3D scene graphs.
- Advanced annotation editing (display-only is optional).
- Arbitrary reslicing on oblique planes (can be a v2 item).
- Collaborative multi-user editing (can be future).

---

## 4. Key Concepts & Data Model

### 4.1 DatasetSummary
Returned by dataset.open(). Describes:
- Dataset id, URI, dtype, shape.
- Axes list with roles, sizes, and optional world transforms (scale, translation).
- Channels and recommended contrast hints.
- Multiscale pyramid levels: per-level shape, chunks, downsample factors.

### 4.2 Layers
Minimal layer model (v1):
- **image**: intensity data with channel controls (composite/single/rgb).
- **labels** (optional): categorical overlays (outline/fill).
- **annotations** (optional display-only): points/boxes/polylines.

### 4.3 ViewState (single source of truth)
A fully serializable object that reproduces a render. Includes:
- Session id, view id, mode (“2d”/“3d”).
- Datasets referenced.
- Viewport size.
- Axis selectors (t/c/etc. indices).
- 2D or 3D camera state.
- Per-layer settings (visibility, opacity, contrast, gamma, colormaps).
- Performance hints (draft/final, progressive, cache budgets).

**Rule:** any render response must echo the final effective selectors and camera used (after clamping).

### 4.4 Render Artifacts & Manifests
Rendering returns:
- Image artifact (inline base64, file path, or URL).
- Completion fraction (if progressive).
- LOD (pyramid level used).
- Timings (I/O, decode, upload, render).

Render packs return:
- Base ViewState hash.
- A list of panels, each defined as JSON Patch applied to base state + an individual RenderResponse.

---

## 5. System Architecture

### 5.1 Components
1) **Viewer Server (daemon, stateful)**
- Maintains sessions, dataset handles, CPU/GPU caches, and GPU context.
- Exposes API endpoints (HTTP or gRPC).

2) **Data Engine**
- Opens datasets, selects multiscale levels, reads chunks asynchronously.
- Maintains LRU caches with explicit memory budgets.
- Provides primitives: get_slice, get_slab, get_subvolume.

3) **Render Engine**
- 2D compositor (CPU or GPU; must be excellent on CPU).
- 3D volume renderer (GPU preferred), with CPU fallback via multi-view 2D pack.

4) **Clients**
- Python client (primary integration surface for agents and pipelines).
- CLI client (thin wrapper around API).
- Optional minimal UI (future): calls the same API.

### 5.2 Progressive Rendering
If chunks are missing, render returns status=partial, completion<1, and chunk_stats. Client can re-render with quality=final.

---

## 6. API Surface (LLM Tool Contract)

### 6.1 Core Endpoints (suggested)
- `GET /capabilities`
- `POST /session/create`
- `POST /dataset/open`
- `POST /dataset/close`
- `POST /view/create`
- `GET /view/{view_id}`
- `POST /view/update` (generic JSON Patch update)
- `POST /render/image`
- `POST /render/pack`
- `POST /probe/value`
- `POST /probe/line_profile`
- `POST /stats/histogram`
- `POST /stats/summary`
- `POST /export/viewstate`
- `POST /import/viewstate`

### 6.2 Operations (verb list)
Navigation/state:
- set_dim(axis=index)
- set_plane(plane=xy|xz|yz, slice index, slab mode)
- pan(dx,dy), zoom(factor)
- orbit(yaw,pitch) / fly(forward,right,up,yaw,pitch)
- fit(dataset|roi|layer)

Rendering:
- render.image(width,height,format,delivery,quality)
- render.pack(preset, output spec, manifest delivery)

Inspection:
- probe.value(x,y,z), per-layer/channel
- line_profile(p0,p1,width)
- histogram(region=view|roi), percentiles
- stats summary (min/max/mean/pXX) for region

Provenance:
- export viewstate
- import viewstate

---

## 7. Presets (Render Packs)

### 7.1 Required v1 presets
- **overview_2d**
  - XY slice at current Z
  - XZ cross-section at current Y
  - YZ cross-section at current X
  - Z MIP (over slab or full Z)
  - Optional: channel composite + per-channel single panels

- **channels_grid**
  - One panel per channel, consistent contrast policy

- **overview_3d** (if GPU 3D enabled)
  - 4 yaw angles around target (0/90/180/270)
  - 1 top-down
  - Optional: 1 MIP panel as fallback

### 7.2 Patch-driven panel definition
Each panel is defined by an RFC 6902 JSON Patch relative to base ViewState, so agents can reason about changes.

---

## 8. Performance Targets (acceptance criteria)

These targets assume chunked multiscale OME‑Zarr on local SSD; remote object storage will vary.

- Open dataset and produce first **draft** XY render at 1024×1024:  
  target < 300 ms local; < 1–2 s remote (depending on network and chunking).

- 2D pan/zoom:  
  should reuse cached tiles; steady-state latency dominated by render not I/O.

- Render pack (6 panels at 768×768):  
  target < 2–4 s on a modest workstation; supports progressive updates.

- Memory:  
  explicit CPU cache budget; no unbounded growth. GPU budget configurable.

---

## 9. Error Handling & Stability

- Errors are structured objects: {code, message, details}.
- Clamp selectors to valid ranges by default and echo final selectors.
- If a requested mode is unsupported (e.g., 3D without GPU), return capabilities + recommended fallback preset.

---

## 10. Security & Operational Notes

- ViewState export should not embed secrets/credentials.
- Dataset URI handling should allow external credential injection (env, config, IAM roles).
- Add configurable maximum render size to prevent OOM.
- Optional rate limiting if running multi-tenant.

---

## 11. Recommended Technology Stack

### 11.1 Recommended v1 Stack (performance + portability)
**Rust viewer server + wgpu rendering + zarrs I/O**, with a thin Python client.

Rust daemon:
- Concurrency: tokio
- API: axum (HTTP) or tonic (gRPC)
- Rendering: wgpu + WGSL shaders
- Zarr I/O: zarrs (+ OME-NGFF metadata parsing)
- Caching: explicit LRU (CPU) + GPU texture cache
- Packaging: single binary, optional GPU feature flags

Python client:
- Pydantic models for DatasetSummary/ViewState/RenderResponse
- Convenience wrappers for common workflows and presets
- Optional integration hooks for agent tool calling

Why this choice:
- Predictable performance for parallel chunk fetch/decode and caching.
- Cross-platform GPU backend via wgpu (Vulkan/Metal/D3D12).
- Headless deployment is straightforward; avoids GUI driver issues.

---

## 12. Phased Delivery Plan

### Phase 1 (MVP)
- OME‑Zarr open + DatasetSummary
- ViewState + axis selectors
- 2D rendering (XY/XZ/YZ), pan/zoom, slab modes
- Snapshot render API (PNG)
- ViewState export/import
- CLI + Python client

### Phase 2
- Render packs (overview_2d, channels_grid)
- Probe and stats endpoints
- Progressive rendering semantics (partial/completion)
- Remote storage tuning (prefetch, cache policy)

### Phase 3
- 3D rendering (MIP + emission-absorption), arcball camera
- overview_3d render pack
- Crop box / clip planes

### Phase 4
- Optional minimal web or desktop UI
- More overlays/annotations
- Oblique slicing / advanced transforms

---

## 13. JSON Schemas (v1)

Note: these are included for developer reference. Implementations may use generated types (Rust serde, Python pydantic) and validate at boundaries.

### 13.1 DatasetSummary.schema.json
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.org/schemas/DatasetSummary.schema.json",
  "title": "DatasetSummary",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "dataset_id", "uri", "axes", "shape", "dtype", "multiscales"],
  "properties": {
    "schema_version": { "type": "integer", "const": 1 },
    "dataset_id": { "type": "string", "minLength": 1 },
    "uri": { "type": "string", "minLength": 1 },
    "opened_at": { "type": "string", "format": "date-time" },
    "axes": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/AxisDef" } },
    "shape": { "type": "array", "minItems": 1, "items": { "type": "integer", "minimum": 1 } },
    "dtype": { "type": "string", "minLength": 1 },
    "world_units": { "type": "string", "default": "micron" },
    "channels": { "type": "array", "items": { "$ref": "#/$defs/ChannelDef" } },
    "multiscales": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/MultiscaleImageDef" } },
    "hints": { "$ref": "#/$defs/DatasetHints" },
    "raw_metadata": { "type": "object", "additionalProperties": true }
  },
  "$defs": {
    "AxisDef": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "role", "size"],
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "role": { "type": "string", "enum": ["x", "y", "z", "c", "t", "other"] },
        "size": { "type": "integer", "minimum": 1 },
        "unit": { "type": "string" },
        "scale": { "type": "number" },
        "translation": { "type": "number" },
        "direction": { "type": "integer", "enum": [-1, 1], "default": 1 }
      }
    },
    "ChannelDef": {
      "type": "object",
      "additionalProperties": false,
      "required": ["index"],
      "properties": {
        "index": { "type": "integer", "minimum": 0 },
        "name": { "type": "string" },
        "color_rgba": {
          "type": "array", "minItems": 4, "maxItems": 4,
          "items": { "type": "number", "minimum": 0, "maximum": 1 }
        },
        "suggested_contrast": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "min": { "type": "number" },
            "max": { "type": "number" },
            "policy": { "type": "string", "enum": ["fixed", "percentile"] },
            "p_low": { "type": "number" },
            "p_high": { "type": "number" }
          }
        },
        "suggested_gamma": { "type": "number" }
      }
    },
    "MultiscaleImageDef": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "axes_order", "levels"],
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "axes_order": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },
        "levels": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/MultiscaleLevelDef" } }
      }
    },
    "MultiscaleLevelDef": {
      "type": "object",
      "additionalProperties": false,
      "required": ["level", "path", "shape", "chunks"],
      "properties": {
        "level": { "type": "integer", "minimum": 0 },
        "path": { "type": "string", "minLength": 1 },
        "shape": { "type": "array", "minItems": 1, "items": { "type": "integer", "minimum": 1 } },
        "chunks": { "type": "array", "minItems": 1, "items": { "type": "integer", "minimum": 1 } },
        "downsample_factors": { "type": "array", "items": { "type": "number", "minimum": 1 } },
        "dtype": { "type": "string" }
      }
    },
    "DatasetHints": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "recommended_tile_px": {
          "type": "array", "minItems": 2, "maxItems": 2,
          "items": { "type": "integer", "minimum": 64 }
        },
        "is_remote": { "type": "boolean" }
      }
    }
  }
}
```

### 13.2 ViewState.schema.json
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.org/schemas/ViewState.schema.json",
  "title": "ViewState",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "view_id", "session_id", "mode", "datasets", "viewport", "selectors", "layers"],
  "properties": {
    "schema_version": { "type": "integer", "const": 1 },
    "view_id": { "type": "string", "minLength": 1 },
    "session_id": { "type": "string", "minLength": 1 },
    "created_at": { "type": "string", "format": "date-time" },
    "mode": { "type": "string", "enum": ["2d", "3d"] },
    "datasets": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/DatasetRef" } },
    "viewport": { "$ref": "#/$defs/Viewport" },
    "selectors": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/AxisSelector" } },
    "view_2d": { "$ref": "#/$defs/View2D" },
    "view_3d": { "$ref": "#/$defs/View3D" },
    "layers": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/LayerState" } },
    "render_settings": { "$ref": "#/$defs/RenderSettings" },
    "performance": { "$ref": "#/$defs/PerformanceHints" },
    "state_hash": { "type": "string" },
    "state_version": { "type": "integer", "minimum": 0 }
  },
  "allOf": [
    { "if": { "properties": { "mode": { "const": "2d" } } }, "then": { "required": ["view_2d"] } },
    { "if": { "properties": { "mode": { "const": "3d" } } }, "then": { "required": ["view_3d"] } }
  ],
  "$defs": {
    "DatasetRef": {
      "type": "object",
      "additionalProperties": false,
      "required": ["dataset_id", "multiscale_name"],
      "properties": { "dataset_id": { "type": "string" }, "multiscale_name": { "type": "string" } }
    },
    "Viewport": {
      "type": "object",
      "additionalProperties": false,
      "required": ["width_px", "height_px"],
      "properties": {
        "width_px": { "type": "integer", "minimum": 1 },
        "height_px": { "type": "integer", "minimum": 1 },
        "pixel_ratio": { "type": "number", "minimum": 0.5, "default": 1.0 }
      }
    },
    "AxisSelector": {
      "type": "object",
      "additionalProperties": false,
      "required": ["axis", "kind"],
      "properties": {
        "axis": { "type": "string", "minLength": 1 },
        "kind": { "type": "string", "enum": ["index", "range", "set"] },
        "index": { "type": "integer", "minimum": 0 },
        "start": { "type": "integer", "minimum": 0 },
        "end_exclusive": { "type": "integer", "minimum": 1 },
        "indices": { "type": "array", "items": { "type": "integer", "minimum": 0 } },
        "clamp": { "type": "boolean", "default": true }
      }
    },
    "View2D": {
      "type": "object",
      "additionalProperties": false,
      "required": ["plane", "camera"],
      "properties": {
        "plane": { "type": "string", "enum": ["xy", "xz", "yz"] },
        "slice": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "axis": { "type": "string" },
            "index": { "type": "integer", "minimum": 0 },
            "slab": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "thickness_vox": { "type": "integer", "minimum": 1, "default": 1 },
                "mode": { "type": "string", "enum": ["single", "mip", "mean"], "default": "single" }
              }
            }
          }
        },
        "camera": { "$ref": "#/$defs/Camera2D" }
      }
    },
    "Camera2D": {
      "type": "object",
      "additionalProperties": false,
      "required": ["center_world", "zoom"],
      "properties": {
        "center_world": { "type": "array", "minItems": 2, "maxItems": 2, "items": { "type": "number" } },
        "zoom": { "type": "number", "minimum": 0.000001 },
        "rotation_deg": { "type": "number", "default": 0.0 }
      }
    },
    "View3D": {
      "type": "object",
      "additionalProperties": false,
      "required": ["camera", "volume"],
      "properties": {
        "camera": { "$ref": "#/$defs/Camera3D" },
        "volume": { "$ref": "#/$defs/VolumeSettings" },
        "crop_box_world": {
          "type": "object",
          "additionalProperties": false,
          "properties": { "min": { "$ref": "#/$defs/Vec3" }, "max": { "$ref": "#/$defs/Vec3" } }
        }
      }
    },
    "Camera3D": {
      "type": "object",
      "additionalProperties": false,
      "required": ["model", "position_world", "target_world", "up_world", "fov_y_deg"],
      "properties": {
        "model": { "type": "string", "enum": ["arcball", "freefly"] },
        "position_world": { "$ref": "#/$defs/Vec3" },
        "target_world": { "$ref": "#/$defs/Vec3" },
        "up_world": { "$ref": "#/$defs/Vec3" },
        "fov_y_deg": { "type": "number", "minimum": 1, "maximum": 179 },
        "near": { "type": "number", "minimum": 0, "default": 0.01 },
        "far": { "type": "number", "minimum": 0, "default": 1000000.0 }
      }
    },
    "VolumeSettings": {
      "type": "object",
      "additionalProperties": false,
      "required": ["method"],
      "properties": {
        "method": { "type": "string", "enum": ["mip", "emission_absorption"] },
        "step_size_world": { "type": "number", "minimum": 0, "default": 1.0 },
        "shading": { "type": "boolean", "default": false },
        "transfer_function": { "type": "array", "items": { "$ref": "#/$defs/TFPoint" } }
      }
    },
    "TFPoint": {
      "type": "object",
      "additionalProperties": false,
      "required": ["x", "rgba"],
      "properties": {
        "x": { "type": "number", "minimum": 0, "maximum": 1 },
        "rgba": { "$ref": "#/$defs/Rgba" }
      }
    },
    "LayerState": {
      "type": "object",
      "additionalProperties": false,
      "required": ["layer_id", "type", "visible", "opacity"],
      "properties": {
        "layer_id": { "type": "string" },
        "type": { "type": "string", "enum": ["image", "labels", "annotations"] },
        "dataset_id": { "type": "string" },
        "source": {
          "type": "object",
          "additionalProperties": false,
          "properties": { "multiscale_name": { "type": "string" }, "array_path": { "type": "string" } }
        },
        "visible": { "type": "boolean" },
        "opacity": { "type": "number", "minimum": 0, "maximum": 1 },
        "image": { "$ref": "#/$defs/ImageLayerSettings" },
        "labels": { "$ref": "#/$defs/LabelLayerSettings" }
      }
    },
    "ImageLayerSettings": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "channel_mode": { "type": "string", "enum": ["single", "rgb", "composite"], "default": "composite" },
        "channels": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["index", "enabled"],
            "properties": {
              "index": { "type": "integer", "minimum": 0 },
              "enabled": { "type": "boolean" },
              "color_rgba": { "$ref": "#/$defs/Rgba" },
              "contrast": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "policy": { "type": "string", "enum": ["fixed", "percentile"], "default": "percentile" },
                  "min": { "type": "number" },
                  "max": { "type": "number" },
                  "p_low": { "type": "number", "default": 1.0 },
                  "p_high": { "type": "number", "default": 99.0 }
                }
              },
              "gamma": { "type": "number", "minimum": 0.01, "default": 1.0 }
            }
          }
        },
        "interpolation": { "type": "string", "enum": ["nearest", "linear"], "default": "linear" }
      }
    },
    "LabelLayerSettings": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "outline": { "type": "boolean", "default": true },
        "outline_width_px": { "type": "integer", "minimum": 0, "default": 1 },
        "show_fill": { "type": "boolean", "default": true }
      }
    },
    "RenderSettings": {
      "type": "object",
      "additionalProperties": false,
      "properties": { "background_rgba": { "$ref": "#/$defs/Rgba" } }
    },
    "PerformanceHints": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "quality": { "type": "string", "enum": ["draft", "final"], "default": "draft" },
        "target_frame_ms": { "type": "integer", "minimum": 1, "default": 200 },
        "progressive": { "type": "boolean", "default": true },
        "lod_mode": { "type": "string", "enum": ["auto", "fixed"], "default": "auto" },
        "fixed_level": { "type": "integer", "minimum": 0 },
        "max_cpu_cache_bytes": { "type": "integer", "minimum": 0 },
        "max_gpu_cache_bytes": { "type": "integer", "minimum": 0 },
        "prefer_gpu": { "type": "boolean", "default": true }
      }
    },
    "Vec3": { "type": "array", "minItems": 3, "maxItems": 3, "items": { "type": "number" } },
    "Rgba": {
      "type": "array",
      "minItems": 4,
      "maxItems": 4,
      "items": { "type": "number", "minimum": 0, "maximum": 1 }
    }
  }
}
```

### 13.3 RenderRequest.schema.json (stateful or stateless render)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.org/schemas/RenderRequest.schema.json",
  "title": "RenderRequest",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "output"],
  "properties": {
    "schema_version": { "type": "integer", "const": 1 },
    "request_id": { "type": "string" },
    "view_id": { "type": "string" },
    "view_state": { "type": "object" },
    "overrides_json_patch": { "type": "array", "items": { "type": "object" } },
    "output": {
      "type": "object",
      "additionalProperties": false,
      "required": ["format", "width_px", "height_px", "delivery"],
      "properties": {
        "format": { "type": "string", "enum": ["png", "jpeg", "webp"] },
        "width_px": { "type": "integer", "minimum": 1 },
        "height_px": { "type": "integer", "minimum": 1 },
        "delivery": { "type": "string", "enum": ["inline_base64", "file_path", "url"] },
        "file_path": { "type": "string" }
      }
    }
  },
  "oneOf": [
    { "required": ["view_id"] },
    { "required": ["view_state"] }
  ]
}
```

### 13.4 RenderResponse.schema.json
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.org/schemas/RenderResponse.schema.json",
  "title": "RenderResponse",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "request_id", "render_id", "status", "state_hash", "images"],
  "properties": {
    "schema_version": { "type": "integer", "const": 1 },
    "request_id": { "type": "string" },
    "render_id": { "type": "string" },
    "view_id": { "type": "string" },
    "status": { "type": "string", "enum": ["ok", "partial", "error"] },
    "completion": { "type": "number", "minimum": 0, "maximum": 1 },
    "state_hash": { "type": "string" },
    "state_version": { "type": "integer", "minimum": 0 },
    "images": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["role", "mime", "width_px", "height_px", "delivery"],
        "properties": {
          "role": { "type": "string", "enum": ["main", "thumbnail", "panel"] },
          "mime": { "type": "string" },
          "width_px": { "type": "integer", "minimum": 1 },
          "height_px": { "type": "integer", "minimum": 1 },
          "delivery": { "type": "string", "enum": ["inline_base64", "file_path", "url"] },
          "bytes_base64": { "type": "string" },
          "file_path": { "type": "string" },
          "url": { "type": "string" },
          "sha256": { "type": "string" }
        }
      }
    },
    "meta": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "dataset_id": { "type": "string" },
        "multiscale_name": { "type": "string" },
        "pyramid_level_used": { "type": "integer", "minimum": 0 },
        "selectors_applied": { "type": "array", "items": { "type": "object", "additionalProperties": true } },
        "timing_ms": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "total": { "type": "number", "minimum": 0 },
            "io": { "type": "number", "minimum": 0 },
            "decode": { "type": "number", "minimum": 0 },
            "gpu_upload": { "type": "number", "minimum": 0 },
            "render": { "type": "number", "minimum": 0 }
          }
        },
        "chunk_stats": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "chunks_requested": { "type": "integer", "minimum": 0 },
            "chunks_ready": { "type": "integer", "minimum": 0 }
          }
        }
      }
    },
    "warnings": { "type": "array", "items": { "type": "object", "additionalProperties": true } },
    "errors": { "type": "array", "items": { "type": "object", "additionalProperties": true } }
  }
}
```

### 13.5 RenderPackResponse.schema.json
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.org/schemas/RenderPackResponse.schema.json",
  "title": "RenderPackResponse",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "pack_id", "preset", "base_state_hash", "panels"],
  "properties": {
    "schema_version": { "type": "integer", "const": 1 },
    "pack_id": { "type": "string" },
    "preset": { "type": "string" },
    "base_view_id": { "type": "string" },
    "base_state_hash": { "type": "string" },
    "panels": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["panel_id", "label", "render", "state_patch_json"],
        "properties": {
          "panel_id": { "type": "string" },
          "label": { "type": "string" },
          "purpose": { "type": "string" },
          "state_patch_json": { "type": "array", "items": { "type": "object", "additionalProperties": true } },
          "render": { "type": "object" }
        }
      }
    }
  }
}
```

### 13.6 Capabilities.schema.json
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.org/schemas/Capabilities.schema.json",
  "title": "Capabilities",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "api_version", "render_modes", "output_formats", "presets"],
  "properties": {
    "schema_version": { "type": "integer", "const": 1 },
    "api_version": { "type": "string" },
    "render_modes": { "type": "array", "items": { "type": "string", "enum": ["2d", "3d"] } },
    "output_formats": { "type": "array", "items": { "type": "string", "enum": ["png", "jpeg", "webp"] } },
    "gpu": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "available": { "type": "boolean" },
        "backend": { "type": "string" },
        "adapter_name": { "type": "string" },
        "limits": { "type": "object", "additionalProperties": true }
      }
    },
    "presets": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "description"],
        "properties": { "name": { "type": "string" }, "description": { "type": "string" } }
      }
    }
  }
}
```

---

## 14. Implementation Notes (non-binding, but recommended)

- Prefer “generic update via JSON Patch” (`/view/update`) for extensibility; also provide convenience endpoints in client libs.
- Canonicalize ViewState for hashing (sorted keys; float quantization).
- Maintain a per-session chunk cache keyed by (dataset_id, level, chunk coords, selectors excluding x/y/z ranges).
- Make LOD selection explicit and explainable: LOD chosen such that voxel-to-screen pixel ratio stays within a target band.
- Return both “draft” and “final” semantics; allow clients to request final for stable analysis snapshots.

## 15. Usage Telemetry + Embedded UI (Phase 4)

### 15.1 Purpose

Provide local operator visibility into how LLM agents use the viewer API:

- Live operation timeline.
- Per-run aggregate metrics.
- Render response preview support when inline image bytes are available.

### 15.2 Correlation Headers

All core endpoints should accept optional request headers:

- `X-Lucida-Agent-Run-Id`
- `X-Lucida-Agent-Step-Id`
- `X-Lucida-Agent-Name`

These headers are additive and must not change endpoint request/response bodies.

### 15.3 Usage API Endpoints

- `GET /usage/events`
  - Query: `limit`, `before_id`, `run_id`, `endpoint`, `status_code`, `from_ts`, `to_ts`
  - Returns reverse-chronological usage events with request/response payload snapshots.
- `GET /usage/runs`
  - Query: `limit`, `before_start_ts`
  - Returns run-level aggregates (`event_count`, `error_count`, `render_count`, p50/p95 latency).
- `GET /usage/runs/{run_id}`
  - Returns one run summary plus recent events.
- `GET /usage/events/stream`
  - SSE stream of newly recorded usage events, optional `run_id` filter.
- `GET /usage/thumbs/{*path}`
  - Serves persisted render thumbnail PNGs under `output/usage/thumbs/*`.
  - Path traversal is rejected.
- `GET /session/list`
  - Returns active in-memory sessions with dataset/view counts and ids.
- `GET /view/list`
  - Query: `session_id` (optional)
  - Returns active in-memory views; can be filtered by session.
- `GET /view/events/stream`
  - Query: `view_id` (required), `session_id` (optional)
  - SSE stream of view-scoped real-time events (`view_event`) for browser live mirror clients.

### 15.4 Embedded UI Routes

- `GET /ui`
- `GET /ui/live`
- `GET /ui/replay`
- `GET /ui/*` static assets

The UI is zero-build static web assets served by the daemon and consumes `/usage/*` APIs plus SSE.
`/ui` is the timeline/analytics surface. `/ui/live` is a read-only real-time mirror for one `view_id`.
`/ui/replay` is a decoupled visual playback surface for step-through action replay.

### 15.5 Telemetry Storage + Retention

Default storage target:

- `output/usage/lucida_usage.sqlite`

Retention defaults:

- Max age: 14 days
- Max rows: 50,000 events
- Max DB size: 1 GiB

Pruning triggers:

- Daemon startup
- After each usage event insert

Environment overrides:

- `LUCIDA_USAGE_DB_PATH`
- `LUCIDA_USAGE_RETENTION_DAYS`
- `LUCIDA_USAGE_MAX_EVENTS`
- `LUCIDA_USAGE_MAX_DB_BYTES`
- `LUCIDA_USAGE_THUMBNAIL_SAMPLE_RATE`
- `LUCIDA_USAGE_THUMBNAIL_MAX_PER_MINUTE`

### 15.6 SSE Semantics

- Event name: `usage_event`
- Data payload: JSON-encoded usage event object.
- Intended for local dashboard live updates; clients may reconnect and hydrate history via `GET /usage/events`.
- Event name: `view_event`
- Data payload schema:
  - `schema_version`
  - `event_type` (`view_state_committed` | `render_completed`)
  - `occurred_at_utc`
  - `endpoint`
  - `view_id`
  - `session_id`
  - `state_hash`
  - `state_version`
  - `render_id`
  - `thumbnail` (`url`, `sha256`, `width_px`, `height_px`) when available
- Intended for real-time browser mirroring of one explicit `view_id`.

### 15.7 Thumbnail Persistence

- Render thumbnails are generated asynchronously from successful `/render/image` inline payloads.
- Thumbnail generation is skipped for non-`inline_base64` deliveries.
- Sampling/rate limiting can be tuned via `LUCIDA_USAGE_THUMBNAIL_SAMPLE_RATE` and `LUCIDA_USAGE_THUMBNAIL_MAX_PER_MINUTE`.
- Thumbnails are resized to fit within a 320px max edge and encoded as PNG.
- Files are stored under `output/usage/thumbs/YYYY-MM-DD/<render_id>.png`.
- Usage telemetry stores thumbnail metadata under `response_json.usage_thumbnail`; full render bytes remain omitted.
- Thumbnail folders are pruned by retention age during telemetry prune cycles.

---

End of spec.
