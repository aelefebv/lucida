# Operation Matrix (Current Capabilities)

## Table of Contents
- [Bootstrap Sequence](#bootstrap-sequence)
  - [`session.create`](#sessioncreate)
  - [`dataset.open`](#datasetopen)
  - [`view.create`](#viewcreate)
  - [`render.image`](#renderimage)
- [View Lifecycle](#view-lifecycle)
  - [`view.state`](#viewstate)
  - [`view.update`](#viewupdate)
  - [`view.export`](#viewexport)
  - [`view.import`](#viewimport)
- [Selector and Camera Helpers](#selector-and-camera-helpers)
  - [`view.dim`](#viewdim)
  - [`view.range`](#viewrange)
  - [`view.indices`](#viewindices)
  - [`view.plane`](#viewplane)
  - [`view.pan`](#viewpan)
  - [`view.zoom`](#viewzoom)
- [Machine-Readable Source](#machine-readable-source)

## Bootstrap Sequence

### `session.create`
- CLI command id: `session.create`
- HTTP route: `POST /session/create`
- Required inputs: none
- Expected outputs: `session_id`, `created_at`

### `dataset.open`
- CLI command id: `dataset.open`
- HTTP route: `POST /dataset/open`
- Required inputs: `uri`
- Expected outputs: `dataset_summary.dataset_id`, `dataset_summary.multiscales`

### `view.create`
- CLI command id: `view.create`
- HTTP route: `POST /view/create`
- Required inputs: `dataset_id`
- Expected outputs: `view_state.view_id`, `view_state.state_hash`, `view_state.state_version`

### `render.image`
- CLI command id: `render.image`
- HTTP route: `POST /render/image`
- Required inputs: `view_id`, `output.width_px`, `output.height_px`
- Expected outputs: `status`, `state_hash`, `images[0].sha256`

## View Lifecycle

### `view.state`
- CLI command id: `view.state`
- HTTP route: `GET /view/{view_id}`
- Required inputs: `view_id`
- Expected outputs: `view_state.state_hash`, `view_state.state_version`

### `view.update`
- CLI command id: `view.update`
- HTTP route: `POST /view/update`
- Required inputs: `view_id`, `patch`
- Expected outputs: `view_state.state_hash`, `view_state.state_version`

### `view.export`
- CLI command id: `view.export`
- HTTP route: `POST /export/viewstate`
- Required inputs: `view_id`
- Expected outputs: `export_id`, `view_state`

### `view.import`
- CLI command id: `view.import`
- HTTP route: `POST /import/viewstate`
- Required inputs: `view_state`
- Expected outputs: `import_id`, `view_state.view_id`, `view_state.state_hash`

## Selector and Camera Helpers

### `view.dim`
- CLI command id: `view.dim`
- HTTP route: `POST /view/update`
- Required inputs: `view_id`, `axis`, `index`
- Expected outputs: `view_state.selectors`, `view_state.state_hash`

### `view.range`
- CLI command id: `view.range`
- HTTP route: `POST /view/update`
- Required inputs: `view_id`, `axis`, `start`, `end_exclusive`
- Expected outputs: `view_state.selectors`, `view_state.state_hash`

### `view.indices`
- CLI command id: `view.indices`
- HTTP route: `POST /view/update`
- Required inputs: `view_id`, `axis`, `indices`
- Expected outputs: `view_state.selectors`, `view_state.state_hash`

### `view.plane`
- CLI command id: `view.plane`
- HTTP route: `POST /view/update`
- Required inputs: `view_id`, `plane`
- Expected outputs: `view_state.view_2d.plane`, `view_state.state_hash`

### `view.pan`
- CLI command id: `view.pan`
- HTTP route: `POST /view/update`
- Required inputs: `view_id`, `dx_px`, `dy_px`
- Expected outputs: `view_state.view_2d.camera.center_world`, `view_state.state_hash`

### `view.zoom`
- CLI command id: `view.zoom`
- HTTP route: `POST /view/update`
- Required inputs: `view_id`, `factor`
- Expected outputs: `view_state.view_2d.camera.zoom`, `view_state.state_hash`

## Machine-Readable Source
Use [operation-matrix.json](operation-matrix.json) as the canonical machine-readable contract for scripts and CI checks.
