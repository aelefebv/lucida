---
created: 2026-06-07
modified: 2026-06-10
---

# Lucida Use Case Test Matrix

This is a high-level acceptance matrix for exercising Lucida as different user
types. It is intentionally phrased in user-value terms rather than implementation
terms. Each row should be tried through the most natural surface: browser, CLI,
Python, or admin CLI.

## Test Datasets

- `/Users/austin/local_data/lucida_test_zarrs/20250925_CPPX245_ISR_Washout_v4.ome.zarr`
- `/Users/austin/local_data/lucida_test_zarrs/czi_test.ome.zarr`
- `/Users/austin/local_data/lucida_test_zarrs/lif_test.ome.zarr`
- `/Users/austin/local_data/lucida_test_zarrs/yeast_3d_mitochondria_large.ome.zarr`

## Matrix

| # | Persona | Use Case | Primary Surface | Smoke Steps | Expected Result | Result | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Biologist | As a biologist, I want to open an OME-Zarr dataset so I can inspect my experiment visually. | Browser + CLI | Open workspace in browser, run `dataset open`. | Dataset appears in browser and `dataset list`. | Pass | CPPX opened through CLI and appeared in the already-open browser. |
| 2 | Biologist | As a biologist, I want to adjust contrast/gamma so I can see dim structures. | Browser + CLI | Apply contrast/gamma changes. | State changes without errors and is observable in viewer/debug state. | Pass | CLI contrast/gamma worked and state reflected it. Browser layer controls now auto-expand for the selected layer and expose explicit labels for contrast/gamma controls. |
| 3 | Biologist | As a biologist, I want to toggle channels on/off and recolor them so I can compare biological markers. | Browser + CLI | Toggle channels and set colormap. | Channel state changes without errors. | Pass | CLI channel visibility and colormap worked. Browser channel controls now expose explicit labels for visibility, colormap, and related settings. |
| 4 | Biologist | As a biologist, I want to move through Z/T/C slices so I can inspect structures across depth, time, and channel. | Browser + CLI | Set Z/T/C indices. | Viewer profile reports requested slice state or rejects invalid indices clearly. | Pass | Valid T/C/Z mutations worked. Out-of-range Z on a Z1 dataset is now rejected with a categorized config error. |
| 5 | Biologist | As a biologist, I want to switch between 2D and 3D camera modes so I can understand spatial context. | Browser + CLI | Switch camera mode and inspect state. | Camera mode changes or reports a clear unsupported/error state. | Pass | CLI camera mode and browser 3D toggle worked. |
| 6 | Biologist | As a biologist, I want an overview view when I get lost so I can quickly reorient myself. | CLI | Run viewer overview capture. | Overview PNG is created and nonblank. | Pass | Headless overview now waits for the app's render-ready signal and produced a nonblank PNG in targeted smoke testing. 2026-06-08 regression smoke used CPPX plate workspace `b8b592a8-ec2b-491e-aaad-1d4a32509366`; `viewer overview` wrote a 1200x800 nonblank PNG after fitting aggregate visible plate bounds. |
| 7 | Image Analyst | As an image analyst, I want to compare multiple loaded datasets/layers so I can evaluate assay differences. | Browser + CLI | Open two datasets and list layers/datasets. | Both datasets are loaded and inspectable. | Pass | CPPX, yeast, and LIF datasets loaded during the pass; browser showed loaded layers. |
| 8 | Image Analyst | As an image analyst, I want to reorder, hide, and adjust opacity of layers so I can inspect overlap. | CLI | Reorder/hide/set opacity. | Layer state changes without errors. | Pass | Reorder, hide/show, and opacity commands succeeded and viewer state reflected changes. |
| 9 | Image Analyst | As an image analyst, I want to inspect dataset metadata and layouts so I understand what I am looking at. | CLI | Run dataset info and layout commands. | Metadata/layout summaries are useful and structured. | Pass | Dataset info, layout list, and active layout output were useful. |
| 10 | Image Analyst | As an image analyst, I want to capture a saved view so I can return to a meaningful state later. | Browser + CLI | Capture, list, show, and apply saved view. | Saved view is durable and apply succeeds. | Pass | Saved view capture/list/show/link/apply worked. |
| 11 | Collaborator | As a collaborator, I want to open a shared workspace link so I can inspect the same data as my teammate. | Browser + CLI | Enable link sharing and open workspace URL. | Link sharing state is visible; browser route opens. | Pass | Link sharing state round-tripped and the browser route opened. |
| 12 | Collaborator | As a collaborator, I want to follow another user's view so I can understand what they are discussing. | CLI + Browser | List peers and follow a peer. | Follow succeeds or fails with a clear reason. | Pass | `peer follow <client-id>` is now a long-lived session that stays connected until Ctrl-C. |
| 13 | Collaborator | As a collaborator, I want to stop following and explore independently so I can investigate my own hypothesis. | CLI | Stop an active follow session. | Follow target clears. | Pass | The live follow command clears follow state on Ctrl-C. The misleading one-shot `peer unfollow` command has been removed from the product CLI. |
| 14 | Collaborator | As a collaborator, I want to copy/share a saved view link so others can land on the same visual state. | CLI | Generate saved-view link. | Link points to workspace route with saved-view fragment. | Pass | Saved-view link generated with a workspace route and bookmark fragment. |
| 15 | PI / Reviewer | As a PI, I want to view a curated saved view without editing shared workspace state so I can review findings safely. | CLI + Browser | Apply/view saved view as read-only flow where possible. | Viewing/applying local state does not mutate shared document unexpectedly. | Pass | Saved view operations worked. Viewer profile links now wait briefly for referenced workspace datasets before applying profile-local view/layer state. |
| 16 | PI / Reviewer | As a reviewer, I want screenshots from a headless view so I can include evidence in notes or reports. | CLI | Run viewer screenshot. | Screenshot PNG is created and nonblank. | Pass | Headless screenshot now waits for the app's render-ready signal and produced a nonblank PNG in targeted smoke testing. 2026-06-08 regression smoke set `channel mode multi`; `viewer screenshot` wrote a 1200x800 nonblank PNG whose UI showed Multi active and all three channel sublayers. |
| 17 | CLI User | As a CLI user, I want to check server/auth/workspace status so I know I am targeting the right Lucida instance. | CLI | Run status and workspace info. | Server/auth/workspace output is clear. | Pass | `status` and `workspace info` were clear. |
| 18 | CLI User | As a CLI user, I want to list and select workspaces so I can operate without opening the GUI first. | CLI | List, create/use/info workspace. | Selection persists for the server. | Pass | List/create/use/info worked. `workspace pin` and `workspace unpin` now decode the server response correctly. |
| 19 | CLI User | As a CLI user, I want to open a dataset from the terminal and see it appear in an already-open browser. | CLI + Browser | Run dataset open while browser is open. | Browser reflects the new dataset. | Pass | Already-open browser reflected datasets opened by CLI. |
| 20 | CLI User | As a CLI user, I want to mutate view/layer/channel state from commands so I can script visual inspection. | CLI | Run view/layer/channel commands. | Commands update durable viewer profile or report clear errors. | Pass | Commands update durable viewer profile state. Existing browser peers reflect shared document changes; profile-local movement is visible through profile links, screenshots, overviews, or live follow. 2026-06-08 regression smoke confirmed `channel mode multi --json` persisted `multi_channel: true` with channels 0-2 visible in the default viewer profile. |
| 21 | CLI User | As a CLI user, I want a durable headless viewer profile so repeated commands build on the same view. | CLI | Run repeated view state mutations and inspect state. | Later commands start from previous state. | Pass | Repeated CLI commands built on prior durable viewer profile state. |
| 22 | Python User | As a Python user, I want to list/use workspaces and open datasets so notebooks can drive Lucida sessions. | Python | Use `LucidaClient` workspace and dataset resources. | Python can list/use/open. | Pass | Worked from the project `uv run` environment. Missing `websockets` now produces guidance toward the project environment or `uv sync`. |
| 23 | Python User | As a Python user, I want to apply view/layer/channel changes so analysis scripts can prepare visual states. | Python | Use Python view/layer/channel resources. | Commands send successfully and state can be inspected. | Pass | Python view pan, channel mode/colormap, and layer opacity succeeded with project dependencies. |
| 24 | Python User | As a Python user, I want to inspect workspace/dataset state so scripts can verify expected results. | Python | Read workspace snapshot/datasets/debug state. | Python returns useful structured state. | Pass | Python returned structured workspace, dataset, and debug state. |
| 25 | Workspace Owner | As a workspace owner, I want to add/remove members and set roles so I can control collaboration access. | CLI | Add, set-role, list, remove a test member. | Member state changes or role policy errors are clear. | Pass | Member add, role change, list, and remove worked. |
| 26 | Workspace Owner | As a workspace owner, I want to turn link sharing on/off so I can choose between restricted and link-based review. | CLI | Set link to viewer/editor/off and show state. | Link sharing state round-trips. | Pass | Viewer, editor, and off link modes round-tripped. |
| 27 | Workspace Owner | As a workspace owner, I want to archive/restore workspaces so old work is hidden but recoverable. | CLI | Create throwaway workspace, archive, list archived, restore. | Workspace moves between active/archived lists. | Pass | Archive, archived list, restore, and info worked. |
| 28 | Admin | As an admin, I want to search workspaces by id/name/member so I can support users. | CLI admin | Run admin workspace search. | Admin search returns useful metadata or clear auth error. | Pass | Admin search returned expected workspace metadata under dev admin auth. |
| 29 | Admin | As an admin, I want to archive/restore or promote an owner remotely so I can recover broken workspace access. | CLI admin | Use admin info/archive/restore/owner on throwaway workspace. | Admin mutations work or report clear auth/role error. | Pass | Admin info, owner add, archive, and restore worked. |
| 30 | Developer / QA | As a developer, I want to inspect debug/plan diagnostics so I can verify chunk planning and viewer state behavior. | CLI | Run debug state and plan visible-chunks. | Diagnostics are structured and useful. | Pass | Debug state and visible-chunks diagnostics worked. Planning output is explicitly lower-level than web chunk planning. |
| 31 | Developer / QA | As a developer, I want failed auth, missing workspace, bad dataset path, and unauthorized mutations to produce clear errors. | CLI + Python | Trigger representative error cases. | Errors are categorized and actionable. | Pass | Missing workspace, bad path, Python missing resource, and unauthorized member mutation returned useful errors. |
| 32 | New User | As a new user, I want the CLI help and command names to be discoverable so I can find the next obvious action. | CLI | Inspect top-level and nested help. | Help exposes current noun model without legacy commands. | Pass | Help exposes the noun model without legacy command families. `peer follow` also accepts its timeout at the leaf command where users naturally try it. |
| 33 | Biologist | As a biologist, I want the minimap to show where my viewport sits on the whole plate so I can navigate fields confidently. | Browser + CLI screenshot | Open CPPX plate, enable multichannel profile state, capture a viewer screenshot, and inspect the minimap. | Minimap renders plate fields and the viewport marker appears on the intersecting field(s), not fixed to the top-left field. | Pass | 2026-06-08 regression smoke used the freshly built web bundle on local server `http://127.0.0.1:9876`; the screenshot showed the member-aware minimap overlay on visible fields while Multi and all channel sublayers were reflected in the UI. |
| 34 | Collaborator / CLI User | As a collaborator using the CLI headlessly, I want to inspect, screenshot, overview, and adopt a live browser peer's current view so I can capture what someone else is seeing without relying on hidden follow persistence. | CLI + Browser | Open a browser peer, run `viewer state --from-peer`, `viewer screenshot --from-peer`, `viewer overview --from-peer`, and `viewer adopt --from-peer`. | Commands read the live peer state, direct captures are nonblank, and adopt persists the peer state into the durable viewer profile. | Pass | 2026-06-10 smoke used workspace `752dddb7-82d3-4899-af44-08292419af1e` on `http://127.0.0.1:9876`; browser peer was client `1`; `viewer state --from-peer 1` reported peer channel contrast, screenshot and overview wrote nonblank 900x650 PNGs, and `viewer state` after adopt showed `Seed: peer:1`. |
| 35 | Developer / Operator | As a developer or operator, I want server-authored dataset health so I can verify bindings, backend type, generated-coarse readiness, and source-cache state without reading logs. | Browser + CLI + Python | Open CPPX, run `dataset health` in human and JSON modes, call `workspace.datasets.health(...)` from Python, then open the browser Debug > Health tab. | Health reports binding, backend, generated coarse, cache counters, and status consistently across browser, CLI, and Python. | Pass | 2026-06-10 CLI/Python smoke used local server `http://127.0.0.1:9991`, workspace `b867894c-cafe-4439-8368-d8da2f65dc92`, and CPPX fixture. Browser parity smoke used `http://127.0.0.1:9992`, workspace `4a481b33-1ad2-433c-b60d-1c4e0f200a75`, and the same fixture; Debug > Health rendered `healthy`, `local`, ready binding, source-cache counters after browser fetches, and generated-coarse status with no console errors. |
| 36 | Developer / Operator | As a developer or operator, I want to retry a persisted dataset binding without removing and re-adding the dataset so I can recover from transient restore/source failures. | Browser + CLI + Python | Open CPPX, run `dataset retry <dataset>`, call `workspace.datasets.retry(...)`, and click Debug > Health > Retry binding. | Retry uses the persisted workspace dataset source, returns the normal structured dataset-open result, and health remains healthy afterward. | Pass | 2026-06-10 smoke used local server `http://127.0.0.1:9992`, workspace `388e0394-4a9f-4a1e-9a85-95e6dc46f94c`, and CPPX fixture. CLI `dataset retry wds-c45...` returned the persisted source URL and dataset summary; Python printed the same workspace dataset id and source; browser Retry binding refreshed the Health tab with no console errors. Server unit coverage also verifies a missing runtime binding with recorded restore failure reports unavailable health, source URL, backend, and failure notes. |

## Full Report

Acceptance pass run on 2026-06-07 against local server
`http://127.0.0.1:9876` with dev auth enabled as `dev@local`.

Workspace used for most tests:
`b44f26e7-aa80-47f8-a6be-bf91d4e5d465`
(`use-case-acceptance-20260607`).

Lifecycle/admin workspace:
`5d310b51-79db-446f-8d52-46a14c7eaadb`
(`use-case-lifecycle-20260607`).

CLI was exercised with `cargo run -p lucida-cli -- ...`. Python was exercised
from `lucida-py` with `uv run python`. Browser checks used the in-app browser
against the local workspace route.

### Current Status

- Pass: 36
- Partial: 0
- Fail: 0
- Product code changes after the original pass addressed the prior full and
  partial gaps. The follow-up retest targeted those gap rows rather than
  rerunning every unchanged row end-to-end.
- 2026-06-08 regression smoke targeted CLI profile screenshot/overview,
  multichannel UI reflection, aggregate plate overview bounds, and the minimap
  viewport overlay on a CPPX plate workspace.
- 2026-06-10 repo state: the shared CLI/Python client PRD landed on `main` in
  PR #760. Stabilization now has repeatable smoke scripts and
  install/invocation docs for the CLI/Python rows. Live-peer to
  headless-profile semantics are covered by row 34. See
  `wiki/outputs/2026-06-10-client-surface-stabilization-plan.md`.

### What Worked Well

- Opening datasets from the CLI works and updates an already-open browser. The
  CPPX, yeast 3D mitochondria, and LIF test datasets were opened successfully.
- Workspace discovery and selection mostly work: status, list, create, use, and
  info are clear enough for ordinary CLI use.
- Core CLI viewer mutation works: view slices, pan, zoom, z-range, camera mode,
  layer order, hide/show, opacity, channel mode, channel visibility, colormap,
  contrast, and gamma all executed successfully.
- Durable headless viewer profile state works across repeated CLI invocations.
- Saved views work through capture, list, show, link, and apply.
- Workspace collaboration management mostly works: member add, role changes,
  removal, link sharing modes, archive/restore, and admin owner/archive/restore
  flows succeeded.
- Python works from the project environment for workspace/dataset operations,
  view/layer/channel mutations, and debug state inspection.
- Error cases are generally categorized and actionable: missing workspace, bad
  dataset path, Python missing dataset, and unauthorized role mutation produced
  useful failures.
- No legacy or compatibility command family surfaced in the help pass.

### Follow-Up Gap Status

1. Headless screenshot and overview capture now wait on the web app's explicit
   render-ready signal instead of a fragile canvas readback probe. Targeted smoke
   testing produced nonblank PNGs for both screenshot and overview.

2. `workspace pin` and `workspace unpin` now decode the server response shape
   correctly after the CLI stopped requiring `user_email` on that response.

3. Viewer profile links now wait briefly for referenced workspace datasets before
   applying profile-local order and settings, which removes the observed
   dataset/profile race.

4. Durable CLI viewer profile movement remains profile-local by design. Users can
   inspect it through `viewer link`, `viewer screenshot`, `viewer overview`, or
   live peer follow rather than expecting already-open browser peers to mirror
   every headless profile mutation automatically.

5. `peer follow <client-id>` is now a long-lived session. It stays connected
   until Ctrl-C and clears follow state before exiting. The misleading one-shot
   `peer unfollow` command was removed from the product CLI.

6. CLI view slice and z-range mutations now validate T/C/Z indices against the
   visible datasets and reject out-of-range requests with categorized config
   errors.

7. Browser layer/channel controls now expose clearer labels for contrast, gamma,
   colormap, channel visibility, layer movement, opacity, render mode, blend
   mode, and detail-level controls. Selecting a layer auto-expands controls when
   no layer is already expanded.

8. Python workspace-session operations still require `websockets`, but the
   missing-dependency error now points source-checkout users to `uv run python`
   or `uv sync`.

9. `peer follow 44 --timeout-seconds 10` is now accepted at the leaf command,
   matching where users naturally place that option.

### Dataset-Specific Notes

- CPPX opened as a plate-like dataset with 64 images, 80 entities, 3 channels,
  and dimensions `T112 C3 Z1 Y1080 X1080`.
- Yeast opened as a single 3D dataset with dimensions
  `T30 C1 Z340 Y960 X1395`; valid Z navigation worked.
- LIF opened through Python with 5 channels and dimensions
  `[1, 5, 1, 1024, 1024]`.

### Stabilization Follow-Up

The original follow-up list is now mostly closed by PR #760. Current reusable
smoke tracking is:

1. CLI smoke: `scripts/smoke_lucida_cli.sh` against a running server with
   `LUCIDA_SMOKE_DATASET` set to a server-visible OME-Zarr path or URL.
2. Python smoke: `uv run --project lucida-py python
   scripts/smoke_python_client.py` against the same server/dataset.
3. Keep this matrix current whenever product-surface changes add or alter a
   workflow row.
