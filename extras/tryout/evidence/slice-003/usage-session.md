# Tryout session

## Render the web viewer
_capture a screenshot of the real SPA viewer on the dataset_
```
$ python3 extras/tryout/tryout.py drive --surface web --json --out <tmp> --fixture ~/local_data/lucida_test_zarrs/lif_test.ome.zarr
exit: 0
```
stdout JSON:
```json
{
  "base_url": "http://127.0.0.1:49377",
  "dataset_id": "wds-e666c8a6d0d542edb984583c2a175632",
  "dataset_name": "lif_test.ome.zarr",
  "db_path": "<tmp>",
  "drive_json": "<tmp>",
  "elapsed_s": 4.607,
  "fixture": "~/local_data/lucida_test_zarrs/lif_test.ome.zarr",
  "healthz": true,
  "ok": true,
  "out_dir": "<tmp>",
  "pid": 6096,
  "requested_surfaces": [
    "web"
  ],
  "server_log": "<tmp>",
  "surfaces": {
    "web": {
      "captures": [
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49377",
            "--workspace",
            "9dab7584-8008-4875-86f1-4bb0a636383e",
            "--json",
            "viewer",
            "screenshot",
            "<tmp>",
            "--timeout-seconds",
            "150"
          ],
          "duration_s": 1.256,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "viewer",
          "nonblank": true,
          "ok": true,
          "png": "<tmp>",
          "png_exists": true,
          "url": "http://127.0.0.1:49377/w/9dab7584-8008-4875-86f1-4bb0a636383e?viewer_profile=default"
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49377",
            "--workspace",
            "9dab7584-8008-4875-86f1-4bb0a636383e",
            "--json",
            "viewer",
            "overview",
            "<tmp>",
            "--timeout-seconds",
            "150"
          ],
          "duration_s": 1.192,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "overview",
          "nonblank": true,
          "ok": true,
          "png": "<tmp>",
          "png_exists": true,
          "url": "http://127.0.0.1:49377/w/9dab7584-8008-4875-86f1-4bb0a636383e?viewer_profile=default"
        }
      ],
      "console_log": "<tmp>",
      "dataset_id": "wds-e666c8a6d0d542edb984583c2a175632",
      "ok": true,
      "out_dir": "<tmp>",
      "ran": true,
      "real_spa": {
        "captured": true,
        "console_log": "<tmp>",
        "console_messages": 0,
        "log": "<tmp>",
        "reason": "rendered",
        "render": {
          "canvas_height": 600,
          "canvas_width": 800,
          "dataset_count": 1,
          "frame_count": 2,
          "ready": true,
          "reason": "rendered"
        },
        "spa_png": "<tmp>",
        "spa_png_nonblank": true,
        "url": "http://127.0.0.1:49377/w/9dab7584-8008-4875-86f1-4bb0a636383e?viewer_profile=default"
      },
      "spa_png": "<tmp>",
      "viewer_png": "<tmp>",
      "viewer_png_nonblank": true,
      "viewer_url": "http://127.0.0.1:49377/w/9dab7584-8008-4875-86f1-4bb0a636383e?viewer_profile=default",
      "web_dist": "~/code/lucida/lucida-web/dist",
      "web_dist_source": "env"
    }
  },
  "teardown": "clean",
  "workspace_id": "9dab7584-8008-4875-86f1-4bb0a636383e",
  "ws_url": "ws://127.0.0.1:49377/ws/workspaces/9dab7584-8008-4875-86f1-4bb0a636383e"
}
```
artifacts produced:
- drive.json (4295 bytes)
- server.log (436 bytes)
- web/console.log (1 bytes)
- web/overview.log (2255 bytes)
- web/overview.png (55893 bytes)
- web/spa-driver.cjs (4248 bytes)
- web/spa-driver.log (411 bytes)
- web/spa.png (71970 bytes)
- web/viewer.log (2249 bytes)
- web/viewer.png (54574 bytes)
server.log (head):
```
# lucida-server: ~/code/lucida/target/debug/lucida-server
# bind: 127.0.0.1:49377
# db: <tmp>
# web_dist: ~/code/lucida/lucida-web/dist
# argv: ~/code/lucida/target/debug/lucida-server serve

client 0 disconnected
client 1 disconnected
client 2 disconnected
client 3 disconnected
client 4 disconnected
client 5 disconnected
```

## All surfaces
_CLI + Python + web captured together_
```
$ python3 extras/tryout/tryout.py drive --surface all --json --out <tmp> --fixture ~/local_data/lucida_test_zarrs/lif_test.ome.zarr
exit: 0
```
stdout JSON:
```json
{
  "base_url": "http://127.0.0.1:49569",
  "dataset_id": "wds-e6da2908ea574761984cde195efbe126",
  "dataset_name": "lif_test.ome.zarr",
  "db_path": "<tmp>",
  "drive_json": "<tmp>",
  "elapsed_s": 5.101,
  "fixture": "~/local_data/lucida_test_zarrs/lif_test.ome.zarr",
  "healthz": true,
  "ok": true,
  "out_dir": "<tmp>",
  "pid": 6201,
  "requested_surfaces": [
    "cli",
    "python",
    "web"
  ],
  "server_log": "<tmp>",
  "surfaces": {
    "cli": {
      "commands": [
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "status"
          ],
          "duration_s": 0.027,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "status",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "status"
          ],
          "duration_s": 0.025,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "status-json",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "server",
            "status"
          ],
          "duration_s": 0.024,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "server-status-json",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "workspace",
            "list"
          ],
          "duration_s": 0.023,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "workspace-list",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "workspace",
            "info",
            "8357571f-e282-4249-a989-534fd273d2a3"
          ],
          "duration_s": 0.023,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "workspace-info",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "dataset",
            "list"
          ],
          "duration_s": 0.026,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "dataset-list",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "dataset",
            "list"
          ],
          "duration_s": 0.023,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "dataset-list-human",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "dataset",
            "info",
            "wds-e6da2908ea574761984cde195efbe126"
          ],
          "duration_s": 0.024,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "dataset-info",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "dataset",
            "health",
            "wds-e6da2908ea574761984cde195efbe126"
          ],
          "duration_s": 0.022,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "dataset-health",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "viewer",
            "state"
          ],
          "duration_s": 0.024,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "viewer-state",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "layout",
            "list"
          ],
          "duration_s": 0.021,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "layout-list",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "saved-view",
            "list"
          ],
          "duration_s": 0.023,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "saved-view-list",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "view",
            "set-zoom",
            "--value",
            "2.0"
          ],
          "duration_s": 0.033,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "view-set-zoom",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "layer",
            "list"
          ],
          "duration_s": 0.024,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "layer-list",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "viewer",
            "state"
          ],
          "duration_s": 0.023,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "viewer-state-after",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "layer",
            "opacity",
            "wds-e6da2908ea574761984cde195efbe126",
            "0.8"
          ],
          "duration_s": 0.024,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "layer-opacity",
          "ok": true
        }
      ],
      "log_dir": "<tmp>",
      "ok": true,
      "passed": 16,
      "ran": true,
      "total": 16
    },
    "python": {
      "log": "<tmp>",
      "ok": true,
      "ran": true,
      "steps": [
        {
          "name": "status",
          "ok": true,
          "summary": {
            "auth": "authenticated",
            "checks": {
              "healthz": true,
              "readyz": true,
              "version": true
            },
            "server": "http://127.0.0.1:49569"
          }
        },
        {
          "name": "workspaces.list",
          "ok": true,
          "summary": {
            "count": 1
          }
        },
        {
          "name": "workspaces.get",
          "ok": true,
          "summary": {
            "id": "8357571f-e282-4249-a989-534fd273d2a3",
            "name": "lucida-tryout-20260619-011730"
          }
        },
        {
          "name": "workspace.open",
          "ok": true,
          "summary": {
            "id": "8357571f-e282-4249-a989-534fd273d2a3"
          }
        },
        {
          "name": "datasets.list",
          "ok": true,
          "summary": {
            "count": 1,
            "ids": [
              "wds-e6da2908ea574761984cde195efbe126"
            ]
          }
        },
        {
          "name": "datasets.info",
          "ok": true,
          "summary": {
            "entity_count": 1,
            "image_count": 1,
            "name": "lif_test.ome.zarr",
            "workspace_dataset_id": "wds-e6da2908ea574761984cde195efbe126"
          }
        },
        {
          "name": "datasets.health",
          "ok": true,
          "summary": {
            "entries": 1,
            "status": [
              "healthy"
            ]
          }
        },
        {
          "name": "layer.list",
          "ok": true,
          "summary": {
            "count": 1
          }
        },
        {
          "name": "debug.state",
          "ok": true,
          "summary": {
            "keys": [
              "datasets",
              "document",
              "generated_availability",
              "own_client_id",
              "peers",
              "snapshot_seq",
              "workspace"
            ]
          }
        },
        {
          "name": "view.set_zoom",
          "ok": true,
          "summary": {
            "own_client_id": 16,
            "zoom": 2.0
          }
        },
        {
          "name": "layer.opacity",
          "ok": true,
          "summary": {
            "ok": true
          }
        },
        {
          "name": "layer.list.after",
          "ok": true,
          "summary": {
            "count": 1
          }
        }
      ]
    },
    "web": {
      "captures": [
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "viewer",
            "screenshot",
            "<tmp>",
            "--timeout-seconds",
            "150"
          ],
          "duration_s": 1.234,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "viewer",
          "nonblank": true,
          "ok": true,
          "png": "<tmp>",
          "png_exists": true,
          "url": "http://127.0.0.1:49569/w/8357571f-e282-4249-a989-534fd273d2a3?viewer_profile=default"
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:49569",
            "--workspace",
            "8357571f-e282-4249-a989-534fd273d2a3",
            "--json",
            "viewer",
            "overview",
            "<tmp>",
            "--timeout-seconds",
            "150"
          ],
          "duration_s": 1.256,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "overview",
          "nonblank": true,
          "ok": true,
          "png": "<tmp>",
          "png_exists": true,
          "url": "http://127.0.0.1:49569/w/8357571f-e282-4249-a989-534fd273d2a3?viewer_profile=default"
        }
      ],
      "console_log": "<tmp>",
      "dataset_id": "wds-e6da2908ea574761984cde195efbe126",
      "ok": true,
      "out_dir": "<tmp>",
      "ran": true,
      "real_spa": {
        "captured": true,
        "console_log": "<tmp>",
        "console_messages": 0,
        "log": "<tmp>",
        "reason": "rendered",
        "render": {
          "canvas_height": 600,
          "canvas_width": 800,
          "dataset_count": 1,
          "frame_count": 3,
          "ready": true,
          "reason": "rendered"
        },
        "spa_png": "<tmp>",
        "spa_png_nonblank": true,
        "url": "http://127.0.0.1:49569/w/8357571f-e282-4249-a989-534fd273d2a3?viewer_profile=default"
      },
      "spa_png": "<tmp>",
      "viewer_png": "<tmp>",
      "viewer_png_nonblank": true,
      "viewer_url": "http://127.0.0.1:49569/w/8357571f-e282-4249-a989-534fd273d2a3?viewer_profile=default",
      "web_dist": "~/code/lucida/lucida-web/dist",
      "web_dist_source": "env"
    }
  },
  "teardown": "clean",
  "workspace_id": "8357571f-e282-4249-a989-534fd273d2a3",
  "ws_url": "ws://127.0.0.1:49569/ws/workspaces/8357571f-e282-4249-a989-534fd273d2a3"
}
```
artifacts produced:
- cli/01-status.log (567 bytes)
- cli/02-status-json.log (1003 bytes)
- cli/03-server-status-json.log (1020 bytes)
- cli/04-workspace-list.log (1076 bytes)
- cli/05-workspace-info.log (1408 bytes)
- cli/06-dataset-list.log (1702 bytes)
- cli/07-dataset-list-human.log (576 bytes)
- cli/08-dataset-info.log (2232 bytes)
- cli/09-dataset-health.log (2553 bytes)
- cli/10-viewer-state.log (3324 bytes)
- cli/11-layout-list.log (1879 bytes)
- cli/12-saved-view-list.log (1354 bytes)
- cli/13-view-set-zoom.log (3417 bytes)
- cli/14-layer-list.log (3320 bytes)
- cli/15-viewer-state-after.log (3324 bytes)
- cli/16-layer-opacity.log (3547 bytes)
- drive.json (16190 bytes)
- python/session.log (2838 bytes)
- server.log (846 bytes)
- web/console.log (1 bytes)
- web/overview.log (2255 bytes)
- web/overview.png (55918 bytes)
- web/spa-driver.cjs (4248 bytes)
- web/spa-driver.log (411 bytes)
- web/spa.png (71720 bytes)
- web/viewer.log (2249 bytes)
- web/viewer.png (54388 bytes)
server.log (head):
```
# lucida-server: ~/code/lucida/target/debug/lucida-server
# bind: 127.0.0.1:49569
# db: <tmp>
# web_dist: ~/code/lucida/lucida-web/dist
# argv: ~/code/lucida/target/debug/lucida-server serve

client 0 disconnected
client 1 disconnected
client 2 disconnected
client 3 disconnected
client 4 disconnected
client 5 disconnected
```

## A wrong fixture
_graceful failure (no hang, no orphan browser)?_
```
$ python3 extras/tryout/tryout.py drive --surface web --json --out <tmp> --fixture /nonexistent/nope.ome.zarr
exit: 1
```
stdout JSON:
```json
{
  "base_url": null,
  "dataset_id": null,
  "db_path": null,
  "drive_json": "<tmp>",
  "error": {
    "detail": {
      "fixture": "/nonexistent/nope.ome.zarr"
    },
    "message": "fixture does not exist: /nonexistent/nope.ome.zarr",
    "stage": "fixture"
  },
  "fixture": "/nonexistent/nope.ome.zarr",
  "healthz": false,
  "ok": false,
  "out_dir": "<tmp>",
  "pid": null,
  "requested_surfaces": [
    "web"
  ],
  "server_log": null,
  "surfaces": {},
  "teardown": "n/a",
  "workspace_id": null,
  "ws_url": null
}
```
artifacts produced:
- drive.json (566 bytes)
