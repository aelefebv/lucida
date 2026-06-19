# Tryout session

## CLI tour
_agent tours the CLI on the real dataset_
```
$ python3 extras/tryout/tryout.py drive --surface cli --json --out <tmp> --fixture ~/local_data/lucida_test_zarrs/lif_test.ome.zarr
exit: 0
```
stdout JSON:
```json
{
  "base_url": "http://127.0.0.1:55248",
  "dataset_id": "wds-d1911e757e2948c3a5f48231e5c852d6",
  "dataset_name": "lif_test.ome.zarr",
  "db_path": "<tmp>",
  "drive_json": "<tmp>",
  "elapsed_s": 0.646,
  "fixture": "~/local_data/lucida_test_zarrs/lif_test.ome.zarr",
  "healthz": true,
  "ok": true,
  "out_dir": "<tmp>",
  "pid": 76204,
  "requested_surfaces": [
    "cli"
  ],
  "server_log": "<tmp>",
  "surfaces": {
    "cli": {
      "commands": [
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "status"
          ],
          "duration_s": 0.026,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "status",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "--json",
            "status"
          ],
          "duration_s": 0.023,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "status-json",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "--json",
            "server",
            "status"
          ],
          "duration_s": 0.023,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "server-status-json",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "--json",
            "workspace",
            "list"
          ],
          "duration_s": 0.022,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "workspace-list",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "--json",
            "workspace",
            "info",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5"
          ],
          "duration_s": 0.021,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "workspace-info",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "--json",
            "dataset",
            "list"
          ],
          "duration_s": 0.023,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "dataset-list",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "dataset",
            "list"
          ],
          "duration_s": 0.025,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "dataset-list-human",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "--json",
            "dataset",
            "info",
            "wds-d1911e757e2948c3a5f48231e5c852d6"
          ],
          "duration_s": 0.026,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "dataset-info",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "--json",
            "dataset",
            "health",
            "wds-d1911e757e2948c3a5f48231e5c852d6"
          ],
          "duration_s": 0.025,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "dataset-health",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "--json",
            "viewer",
            "state"
          ],
          "duration_s": 0.023,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "viewer-state",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "--json",
            "layout",
            "list"
          ],
          "duration_s": 0.024,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "layout-list",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "--json",
            "saved-view",
            "list"
          ],
          "duration_s": 0.022,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "saved-view-list",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "--json",
            "view",
            "set-zoom",
            "--value",
            "2.0"
          ],
          "duration_s": 0.025,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "view-set-zoom",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "--json",
            "layer",
            "list"
          ],
          "duration_s": 0.023,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "layer-list",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "--json",
            "viewer",
            "state"
          ],
          "duration_s": 0.022,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "viewer-state-after",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55248",
            "--workspace",
            "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
            "--json",
            "layer",
            "opacity",
            "wds-d1911e757e2948c3a5f48231e5c852d6",
            "0.8"
          ],
          "duration_s": 0.023,
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
    }
  },
  "teardown": "clean",
  "workspace_id": "59a1aa6a-6f43-4584-89b7-0c63c43b24e5",
  "ws_url": "ws://127.0.0.1:55248/ws/workspaces/59a1aa6a-6f43-4584-89b7-0c63c43b24e5"
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
- drive.json (9982 bytes)
- server.log (493 bytes)
server.log (head):
```
# lucida-server: ~/code/lucida/target/debug/lucida-server
# bind: 127.0.0.1:55248
# db: <tmp>
# argv: ~/code/lucida/target/debug/lucida-server serve

client 0 disconnected
client 1 disconnected
client 2 disconnected
client 3 disconnected
client 4 disconnected
client 5 disconnected
client 6 disconnected
```

## Python tour
_a real LucidaClient session, captured_
```
$ python3 extras/tryout/tryout.py drive --surface python --json --out <tmp> --fixture ~/local_data/lucida_test_zarrs/lif_test.ome.zarr
exit: 0
```
stdout JSON:
```json
{
  "base_url": "http://127.0.0.1:55291",
  "dataset_id": "wds-d50933a726b54f8bb6123ffee82f3747",
  "dataset_name": "lif_test.ome.zarr",
  "db_path": "<tmp>",
  "drive_json": "<tmp>",
  "elapsed_s": 0.305,
  "fixture": "~/local_data/lucida_test_zarrs/lif_test.ome.zarr",
  "healthz": true,
  "ok": true,
  "out_dir": "<tmp>",
  "pid": 76386,
  "requested_surfaces": [
    "python"
  ],
  "server_log": "<tmp>",
  "surfaces": {
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
            "server": "http://127.0.0.1:55291"
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
            "id": "a307310f-914a-439a-8079-20425f1332b9",
            "name": "lucida-tryout-20260619-003052"
          }
        },
        {
          "name": "workspace.open",
          "ok": true,
          "summary": {
            "id": "a307310f-914a-439a-8079-20425f1332b9"
          }
        },
        {
          "name": "datasets.list",
          "ok": true,
          "summary": {
            "count": 1,
            "ids": [
              "wds-d50933a726b54f8bb6123ffee82f3747"
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
            "workspace_dataset_id": "wds-d50933a726b54f8bb6123ffee82f3747"
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
            "own_client_id": 6,
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
    }
  },
  "teardown": "clean",
  "workspace_id": "a307310f-914a-439a-8079-20425f1332b9",
  "ws_url": "ws://127.0.0.1:55291/ws/workspaces/a307310f-914a-439a-8079-20425f1332b9"
}
```
artifacts produced:
- drive.json (3488 bytes)
- python/session.log (2836 bytes)
- server.log (448 bytes)
server.log (head):
```
# lucida-server: ~/code/lucida/target/debug/lucida-server
# bind: 127.0.0.1:55291
# db: <tmp>
# argv: ~/code/lucida/target/debug/lucida-server serve

client 0 disconnected
client 1 disconnected
client 2 disconnected
client 3 disconnected
client 4 disconnected
client 5 disconnected
client 6 disconnected
```

## Both surfaces at once
_one command, both surfaces captured_
```
$ python3 extras/tryout/tryout.py drive --surface all --json --out <tmp> --fixture ~/local_data/lucida_test_zarrs/lif_test.ome.zarr
exit: 0
```
stdout JSON:
```json
{
  "base_url": "http://127.0.0.1:55316",
  "dataset_id": "wds-5a8e4715b0cd447e9586f201de1b4a71",
  "dataset_name": "lif_test.ome.zarr",
  "db_path": "<tmp>",
  "drive_json": "<tmp>",
  "elapsed_s": 0.681,
  "fixture": "~/local_data/lucida_test_zarrs/lif_test.ome.zarr",
  "healthz": true,
  "ok": true,
  "out_dir": "<tmp>",
  "pid": 76398,
  "requested_surfaces": [
    "cli",
    "python"
  ],
  "server_log": "<tmp>",
  "surfaces": {
    "cli": {
      "commands": [
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
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
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
            "--json",
            "status"
          ],
          "duration_s": 0.023,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "status-json",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
            "--json",
            "server",
            "status"
          ],
          "duration_s": 0.021,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "server-status-json",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
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
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
            "--json",
            "workspace",
            "info",
            "c8867693-d3fc-4563-a830-ffdea7933cb2"
          ],
          "duration_s": 0.022,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "workspace-info",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
            "--json",
            "dataset",
            "list"
          ],
          "duration_s": 0.024,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "dataset-list",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
            "dataset",
            "list"
          ],
          "duration_s": 0.026,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "dataset-list-human",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
            "--json",
            "dataset",
            "info",
            "wds-5a8e4715b0cd447e9586f201de1b4a71"
          ],
          "duration_s": 0.026,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "dataset-info",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
            "--json",
            "dataset",
            "health",
            "wds-5a8e4715b0cd447e9586f201de1b4a71"
          ],
          "duration_s": 0.025,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "dataset-health",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
            "--json",
            "viewer",
            "state"
          ],
          "duration_s": 0.023,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "viewer-state",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
            "--json",
            "layout",
            "list"
          ],
          "duration_s": 0.022,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "layout-list",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
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
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
            "--json",
            "view",
            "set-zoom",
            "--value",
            "2.0"
          ],
          "duration_s": 0.026,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "view-set-zoom",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
            "--json",
            "layer",
            "list"
          ],
          "duration_s": 0.023,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "layer-list",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
            "--json",
            "viewer",
            "state"
          ],
          "duration_s": 0.022,
          "exit_code": 0,
          "log": "<tmp>",
          "name": "viewer-state-after",
          "ok": true
        },
        {
          "argv": [
            "~/code/lucida/target/debug/lucida",
            "--server",
            "http://127.0.0.1:55316",
            "--workspace",
            "c8867693-d3fc-4563-a830-ffdea7933cb2",
            "--json",
            "layer",
            "opacity",
            "wds-5a8e4715b0cd447e9586f201de1b4a71",
            "0.8"
          ],
          "duration_s": 0.028,
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
            "server": "http://127.0.0.1:55316"
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
            "id": "c8867693-d3fc-4563-a830-ffdea7933cb2",
            "name": "lucida-tryout-20260619-003052"
          }
        },
        {
          "name": "workspace.open",
          "ok": true,
          "summary": {
            "id": "c8867693-d3fc-4563-a830-ffdea7933cb2"
          }
        },
        {
          "name": "datasets.list",
          "ok": true,
          "summary": {
            "count": 1,
            "ids": [
              "wds-5a8e4715b0cd447e9586f201de1b4a71"
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
            "workspace_dataset_id": "wds-5a8e4715b0cd447e9586f201de1b4a71"
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
    }
  },
  "teardown": "clean",
  "workspace_id": "c8867693-d3fc-4563-a830-ffdea7933cb2",
  "ws_url": "ws://127.0.0.1:55316/ws/workspaces/c8867693-d3fc-4563-a830-ffdea7933cb2"
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
- drive.json (12683 bytes)
- python/session.log (2838 bytes)
- server.log (677 bytes)
server.log (head):
```
# lucida-server: ~/code/lucida/target/debug/lucida-server
# bind: 127.0.0.1:55316
# db: <tmp>
# argv: ~/code/lucida/target/debug/lucida-server serve

client 0 disconnected
client 1 disconnected
client 2 disconnected
client 3 disconnected
client 4 disconnected
client 5 disconnected
client 6 disconnected
```

## A wrong fixture
_graceful failure?_
```
$ python3 extras/tryout/tryout.py drive --surface cli --json --out <tmp> --fixture /nonexistent/nope.ome.zarr
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
    "cli"
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
