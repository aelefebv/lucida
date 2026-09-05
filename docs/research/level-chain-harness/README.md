# level-chain harness (issue #1003)

Measurement tooling for the "Measured, before and after" section of
[ADR 0061](../../../wiki/decisions/0061-screen-chosen-target-level-with-resident-coarser-levels.md).
Not part of the product and not wired into CI. It answers one question on a wide
collection zoomed out to show every tile: what does the level-0 default cost against
the screen-chosen target level, in chunks per rebuild, bytes, and time to a quiescent
view, at device pixel ratio 2?

It succeeds `docs/research/remote-rates-harness/` (#899), whose throwaway
instrumentation patch no longer applies. Everything that harness patched in is now on
the trace: the server's per-read timing rows carry `backend_bytes`, and the per-tick
aggregate carries the target level, the displayed level, and the per-lane request
counts. So this harness is a thin loop around `lucida trace`.

```bash
# 1. build what the runs use
(cd lucida-web && pnpm run build:wasm && pnpm install && pnpm run build)
cargo build --release -p lucida-server -p lucida-cli

# 2. a remote dataset needs the operator's own application default credentials
gcloud auth application-default login

# 3. run: one fresh server and one fresh browser per run, pinned and screen alternating
uv run docs/research/level-chain-harness/lc_run.py /tmp/lc/remote gs://BUCKET/PATH.zarr --rounds 2

# 4. a local twin of the same per-tile geometry, when the remote dataset is out of reach
uv run extras/synthetic_ome_zarr.py /tmp/twin.ome.zarr --tiles 21371 --size 3,256,256 --levels 2 --factor 1,8,8 --chunk 3,256,256
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
| settled, run s | the run's `endReason` and duration: `quiescent`, or `timeout` at `--timeout-seconds` with what it had by then |
| target | the target level range on the last planning pass, with `(pin)` when the level pin chose it |
| detail per rebuild, coarse per rebuild | the most requests any one planning pass emitted on that lane (`laneDetail`, `laneCoarse` tick counters): the wanted set per rebuild, split by tier |
| detail rows | lifecycle rows on the detail lane at the target level over the whole run |
| backend reads, MB read | server timing rows with `backendBytes`: reads that reached the object store, and their byte total |
| reads/s, MB/s | those reads over the span from the first read's start to the last read's end: the link on the day |

The tick counters, not the rows, are the wanted-set figure. A row is one request's
life over the whole run, so a set the page keeps re-planning appears once in the rows
and once per pass in the counters, and ADR 0044's "requests per submit" is the latter.

## Gotchas

- **One server per run is what makes the numbers cold.** The server caches a source
  by path for the life of the process (#902), so a second run against the same
  server reads nothing from the object store. The harness never reuses a server.
- **The pinned run on a wide collection does not settle.** That is the finding, not a
  harness fault. `--timeout-seconds` bounds it, and the report says `no (timeout)`
  with what the page had planned and read by then.
- **Verify device pixel ratio 2 from the frame, not the run's word.** A 1440×900
  viewport writes a 2880×1800 `frame.png`.
- **A `gs://` dataset needs the operator's credentials.** The harness drops
  `GOOGLE_APPLICATION_CREDENTIALS` and its service-account cousins so the application
  default credentials win. If `gcloud auth application-default print-access-token`
  says "Reauthentication failed", the server sees the same expired credential, and
  only an interactive `gcloud auth application-default login` fixes it.
- **The tryout harness owns the server process.** `lc_run.py` imports
  `extras/tryout` for `ServerProcess`, the same way `remote-rates-harness` did, and
  writes each run's `server.log` beside its run file.
