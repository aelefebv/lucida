# level-chain harness (issue #1003)

Measurement tooling for the "Measured, before and after" section of ADR 0061.
Not part of the product and not wired into CI. It answers one question on a wide
collection zoomed out to show every tile: what does the level-0 default cost against
the screen-chosen target level, in chunks per rebuild, bytes, and time to a quiescent
view, at device pixel ratio 2?

It needs no instrumentation patch. The server's per-read timing rows carry
`backend_bytes`, and the per-tick aggregate carries the target level, the displayed
level, and the per-lane request counts. So this harness is a thin loop around
`lucida trace`. ADR 0061 has the results.

```bash
# 1. build what the runs use
(cd lucida-web && pnpm run build:wasm && pnpm install && pnpm run build)
cargo build --release -p lucida-server -p lucida-cli

# 2. a remote dataset needs the operator's own application default credentials
gcloud auth application-default login

# 3. run: one fresh server and one fresh browser per run, pinned and screen alternating
uv run docs/research/level-chain-harness/lc_run.py /tmp/lc/remote gs://BUCKET/PATH.zarr --rounds 2

# 4. a local twin of the same per-tile geometry, when the remote dataset is out of reach
uv run extras/synthetic_ome_zarr.py /tmp/twin.ome.zarr --tiles 21371 --size 3,256,256 --levels 2 --factor 1,8,8 --chunk 3,256,256 --chunk 3,32,32
uv run docs/research/level-chain-harness/lc_run.py /tmp/lc/twin /tmp/twin.ome.zarr --rounds 2
```

`lc_run.py` boots the server from `target/release/lucida-server` with the bundle in
`lucida-web/dist` (override with `--server-bin` and `--web-dist`), opens the dataset
in a new workspace through the CLI, and drives `lucida trace --camera slice` at device
pixel ratio 2, once with `--level-pin 0` (the level-0 default that ADR 0061 replaced)
and once following the screen. Each round alternates the order. The report is a
Markdown table, and `summary.json` in the output directory holds the same numbers with
the run file and frame of every run.

## What each column is

| column | source |
| --- | --- |
| open s | wall time of `lucida dataset open`, taken before the run, so the run itself measures the view and not the open |
| quiescent, run s | whether the page published quiescent and closed its own run, and the run's duration; a `timeout` run reports what it had by then |
| target | the target level range on the last planning pass, with `(pin)` when the level pin chose it |
| detail per rebuild, coarse per rebuild | the most requests any one planning pass emitted on that lane (`laneDetail`, `laneCoarse` tick counters): the wanted set per rebuild, split by tier |
| detail resident at end, coarse resident at end | the page's resident chunk counts against what it wanted when the run closed |
| resident plateau | the most bytes the run's readings saw resident on the GPU, and when they first got there. A plateau at a residency budget is a page that stopped growing, not one that finished |
| server reads | the server's own count of backend reads during the run, from `lucida dataset health` before and after |
| traced reads, traced MB | server timing rows with `backendBytes`: reads that reached the object store, and their byte total. `(capped)` marks a run whose recorder hit its per-run cap, where these are a sample and `server reads` is the whole figure |
| reads/s, MB/s | the traced reads over the span from the first read's start to the last read's end: the link on the day |

The tick counters, not the rows, are the wanted-set figure. A row is one request's
life over the whole run, so a set the page keeps re-planning appears once in the rows
and once per pass in the counters, and ADR 0044's "requests per submit" is the latter.
`summary.json` also keeps each run's lifecycle-row count at the target level and, when
every one of those rows completed, the moment the last was presented.

## Gotchas

- One server per run is what makes the numbers cold. The server caches a source
  by path for the life of the process (#902), so a second run against the same
  server reads nothing from the object store. The harness never reuses a server.
- The pinned run on a wide collection never reaches quiescence. That is the finding,
  not a harness fault. The page closes its run at 60 s (#1043), and the report says
  `no (timeout)` with what the page had planned and read by then.
- Verify device pixel ratio 2 from the frame, not the run's word. A 1440×900
  viewport writes a 2880×1800 `frame.png`.
- A `gs://` dataset needs the operator's credentials. The harness drops
  `GOOGLE_APPLICATION_CREDENTIALS` and its service-account cousins so the application
  default credentials win. If `gcloud auth application-default print-access-token`
  says "Reauthentication failed", the server sees the same expired credential, and
  only an interactive `gcloud auth application-default login` fixes it.
- A twin must declare each level's own chunk shape. A twin that declared the
  level-0 chunk shape at level 1 made both modes plateau at the same chunk count,
  because a slot costs the declared chunk (#1042). The second `--chunk` in the command
  above is what corrects it.
- The tryout harness owns the server process. `lc_run.py` imports
  `extras/tryout` for `ServerProcess` and writes each run's `server.log` beside its
  run file.
