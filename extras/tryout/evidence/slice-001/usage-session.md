# Tryout session

## One command, with a dataset
_agent brings lucida up from cold, with a fixture_
```
$ python3 extras/tryout/tryout.py up --once --json --out <tmp> --fixture ~/local_data/lucida_test_zarrs/lif_test.ome.zarr
exit: 0
```
stdout JSON:
```json
{
  "base_url": "http://127.0.0.1:51194",
  "dataset": {
    "entity_count": 1,
    "image_count": 1,
    "name": "lif_test.ome.zarr",
    "source": "~/local_data/lucida_test_zarrs/lif_test.ome.zarr",
    "workspace_dataset_id": "wds-3cdf6d32699b4177bce888aa1a551726"
  },
  "dataset_id": "wds-3cdf6d32699b4177bce888aa1a551726",
  "db_path": "<tmp>",
  "elapsed_s": 1.006,
  "fixture": "~/local_data/lucida_test_zarrs/lif_test.ome.zarr",
  "health_elapsed_s": 0.87,
  "healthz": true,
  "ok": true,
  "out_dir": "<tmp>",
  "pid": 34786,
  "server_log": "<tmp>",
  "teardown": "clean",
  "up_json": "<tmp>",
  "web_url": "http://127.0.0.1:51194/w/eec965b0-7131-40bd-a400-763c8263000f",
  "workspace_id": "eec965b0-7131-40bd-a400-763c8263000f",
  "ws_url": "ws://127.0.0.1:51194/ws/workspaces/eec965b0-7131-40bd-a400-763c8263000f"
}
```
artifacts produced:
- server.log (272 bytes)
- up.json (1048 bytes)
server.log (head):
```
# lucida-server: ~/code/lucida/target/debug/lucida-server
# bind: 127.0.0.1:51194
# db: <tmp>
# argv: ~/code/lucida/target/debug/lucida-server serve

client 0 disconnected
```

## Bring it up, no dataset
_just a live server + workspace_
```
$ python3 extras/tryout/tryout.py up --once --json --out <tmp>
exit: 0
```
stdout JSON:
```json
{
  "base_url": "http://127.0.0.1:51212",
  "dataset": {
    "entity_count": 1,
    "image_count": 1,
    "name": "lif_test.ome.zarr",
    "source": "~/local_data/lucida_test_zarrs/lif_test.ome.zarr",
    "workspace_dataset_id": "wds-fa2a89005af2469e9d2456327d4e3c6e"
  },
  "dataset_id": "wds-fa2a89005af2469e9d2456327d4e3c6e",
  "db_path": "<tmp>",
  "elapsed_s": 0.152,
  "fixture": "~/local_data/lucida_test_zarrs/lif_test.ome.zarr",
  "health_elapsed_s": 0.015,
  "healthz": true,
  "ok": true,
  "out_dir": "<tmp>",
  "pid": 34791,
  "server_log": "<tmp>",
  "teardown": "clean",
  "up_json": "<tmp>",
  "web_url": "http://127.0.0.1:51212/w/994502a8-723f-4c02-9daf-a5c704cfc3c4",
  "workspace_id": "994502a8-723f-4c02-9daf-a5c704cfc3c4",
  "ws_url": "ws://127.0.0.1:51212/ws/workspaces/994502a8-723f-4c02-9daf-a5c704cfc3c4"
}
```
artifacts produced:
- server.log (272 bytes)
- up.json (1049 bytes)
server.log (head):
```
# lucida-server: ~/code/lucida/target/debug/lucida-server
# bind: 127.0.0.1:51212
# db: <tmp>
# argv: ~/code/lucida/target/debug/lucida-server serve

client 0 disconnected
```

## A wrong path
_does it fail gracefully?_
```
$ python3 extras/tryout/tryout.py up --once --json --out <tmp> --fixture /nonexistent/nope.ome.zarr
exit: 1
```
stdout JSON:
```json
{
  "base_url": null,
  "dataset_id": null,
  "db_path": null,
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
  "server_log": null,
  "teardown": "n/a",
  "up_json": "<tmp>",
  "workspace_id": null,
  "ws_url": null
}
```
artifacts produced:
- up.json (507 bytes)

## Discoverability
_what is this tool?_
```
$ python3 extras/tryout/tryout.py --help
exit: 0
```
stdout:
```
usage: tryout.py [-h] <command> ...

lucida agent tryout harness: bring up a live lucida-server from the current working tree, report how to reach it, then tear it down.

positional arguments:
  <command>
    up        bring up a live lucida, report it, and (with --once) tear it
              down

options:
  -h, --help  show this help message and exit

Environment:
  LUCIDA_TRYOUT_SERVER_BIN  reuse this prebuilt lucida-server (skip the build)
  LUCIDA_TRYOUT_CLI         reuse this prebuilt lucida CLI binary
  LUCIDA_TRYOUT_FIXTURE     default --fixture path
  LUCIDA_TRYOUT_UV          uv binary used to drive the lucida-py client
```
