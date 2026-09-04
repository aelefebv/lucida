# Merged range reads: requests before and after (issue #1012)

Measurement for the second phase of the sharded-array spec ([#990]): range
reads of one shard that queue for a source-read permit together go out as one
request. The decision it informed is
[ADR 0062](../../wiki/decisions/0062-merged-range-reads-at-the-permit-queue.md).

Every figure is tagged **[M]** measured / **[C]** read from code / **[U]** unknown.

[#990]: https://github.com/aelefebv/lucida/issues/990
[#1012]: https://github.com/aelefebv/lucida/issues/1012

---

## 0. Conditions

| | |
| --- | --- |
| Machine | Apple M5 Max, macOS 26.5.0 [M] |
| Client → server | loopback; the browser never talks to the object store [C] |
| Server → object store | loopback to a Python stand-in that answers Range requests, delays every response by **80 ms**, and logs every request (`merged-range-reads-harness/range_server.py`) [C] |
| Source-read cap | the default, 16 permits (`DEFAULT_SOURCE_READ_CONCURRENCY`) [C] |
| Wall-clock | 2026-09-04, about 15:15 to 15:50 PDT [M] |
| Builds | one working tree, debug profile; the before binary is the same tree with the merge switched off (`mergeable = false`) [C] |
| Web dist | built from the same tree; identical for every run [C] |
| DPR | **devicePixelRatio 2** on every run. `cold.png` is 3200 × 2000 for the 1600 × 1000 viewport [M] |
| Rendered? | yes. `ready(cold)` and `ready(warm)` read `rendered` on every run [M] |

The `gs://` fixture the remote-rates note used is unsharded, so it cannot
exercise a merge, and this environment's credentials cannot read it anyway.
A stand-in on the loopback with injected latency is the substitute the earlier
monitor work settled on: it is the real remote code path (`object_store`'s HTTP
backend, the same range requests) with a latency that is known rather than
weather.

### Fixture

Synthetic, written by `extras/synthetic_ome_zarr.py`:

```
--size 4096,4096 --chunk 64 --shard 512 --levels 4 --seed 3
```

One image, four levels, 64 × 64 inner chunks in 8 × 8 shards, index at the end.
Inner chunks are ~5 KB compressed; a level-0 shard is ~400 KB [M]. Inner chunks
lie in the shard in position order, so a run along `x` is byte-contiguous [M].

### Drive

The remote-rates driver unchanged (`docs/research/remote-rates-harness/rr_driver.cjs`):
cold open, 5 s idle, 10 s circular pan, 8 s wheel zoom, warm reload. The
opening view is the workspace default, which lands zoomed into one corner of the
image at level 0, so the phases touch 5 to 7 shards rather than the whole level.
That is a light workload, not a full-screen fill.

### Harness

`docs/research/merged-range-reads-harness/`: the stand-in, a one-run wrapper
around `rr_run.py`, and two readers of the access log. The README says how to
reproduce.

---

## 1. The comparison

Requests are chunk range requests (`206` to a path under a level directory) the
stand-in saw inside each phase's window. Cold and pan are deterministic across
runs. The same wanted set and the same bytes came back every time. Zoom is not: the wheel
zoom's timing lands differently run to run, and in one run (`contig-2`) it
went somewhere else entirely (7 objects, 4.04 MB total against 2.54 MB for
every other run). So the comparison is **cold + pan**, and zoom is reported
but not compared. Variants alternated run to run so none owned a stretch of
the machine.

| Variant | Run | Cold | Pan | **Cold + pan** | Zoom | Total requests | Total bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| no merge | 1 | 139 | 197 | **336** | 72 | 489 | 2,540,036 |
| no merge | 2 | 139 | 197 | **336** | 22 | 489 | 2,540,036 |
| no merge | 3 | 139 | 194 | **333** | 56 | 489 | 2,540,036 |
| contiguous merge (shipped) | 1 | 115 | 166 | **281** | 20 | 410 | 2,540,036 |
| contiguous merge (shipped) | 2 | 117 | 169 | **286** | 158* | 764* | 4,039,613* |
| contiguous merge, gap constant at 0 (pre-refactor build) | 1 | 117 | 166 | **283** | 56 | 413 | 2,540,036 |
| contiguous + one yield before claiming (not shipped) | 1 | 98 | 139 | **237** | 11 | 330 | 2,540,036 |
| contiguous + one yield before claiming (not shipped) | 2 | 100 | 143 | **243** | 55 | 361 | 2,540,036 |
| object_store's 1 MiB gap (not shipped) | 1 | 101 | 135 | **236** | 20 | 353 | **8,197,226** |

\* the zoom diverged; cold and pan did not.

Requests per second in the pan, the phase that is a pan across a sharded
dataset [M]:

| Variant | Pan req/s |
| --- | --- |
| no merge | 19.6 / 19.6 / 19.3 |
| contiguous merge | 16.5 / 16.8 |
| contiguous + yield | 13.8 / 14.2 |
| 1 MiB gap | 13.4 |

Requests per second falls because there are fewer requests for the same bytes
in the same ten seconds, not because the link slowed: the pan's byte counts
are equal across variants (1,077,286 to 1,092,989) except the gap variant's
4,623,305.

Request sizes, all phases pooled [M]:

| Variant | p50 | p90 | max |
| --- | --- | --- | --- |
| no merge | 4,986 | 7,421 | 7,995 |
| contiguous merge | 5,173 | 9,666 | 30,508 |
| contiguous + yield | 5,321 | 12,551 | 50,803 |
| 1 MiB gap | 5,365 | 61,883 | 315,737 |

A single inner chunk is under 8 KB. Anything larger is a merged request; the
1 MiB gap's 315 KB maximum is most of a shard.

### Was the cap binding?

A floor on reads in flight at the stand-in, from start times and the 80 ms
hold (`concurrency.py`) [M]:

| Variant | p50 | p90 | max |
| --- | --- | --- | --- |
| no merge | 11-12 | 15-16 | 16 |
| contiguous merge | 11 | 15 | 16-17 |
| contiguous + yield | 9-11 | 15 | 16 |

The browser keeps more than 16 requests outstanding, so the cap was reached
and reads did queue, which is the only condition under which anything merges.
The queue was shallow, though: the p50 sits under the cap, so most of the time
a newly arriving read found a permit free and went out alone.

---

## 2. What it says

1. **Contiguous merging removes about one request in six at no byte cost.**
   Cold + pan went from 336 requests to 281 and 286, same 2.54 MB, same picture. It is the
   change the ticket asked for, and its cost is a memcpy per carried range.
2. **The transport's gap is a bad trade here.** object_store's multi-range read
   merges ranges up to 1 MiB apart. Routing queued reads through that with no
   tighter rule removed 30 % of cold + pan requests and moved **3.2× the bytes**
   (8.20 MB against 2.54 MB). With ~5 KB inner chunks in ~400 KB shards, any
   two wanted chunks of a shard are within the gap, so a merged request became
   the span between them, and the bytes between are inner chunks the view had
   not asked for, fetched and dropped, because the cache has no key to file
   them under. On the measured remote link (~18 MiB/s aggregate, ~57 reads/s)
   the break-even is roughly 320 KB of extra bytes per request saved; a gap
   that can spend 1 MiB per merge is a bet the link is bandwidth-rich, and it
   is the whole-shard download sharding exists to avoid, by another route.
   Hence ADR 0062's rule: nothing merges across a gap.
3. **The window, not the rule, is what limits the gain.** In the yield variant
   a read registers, lets the runtime run once, then asks for its permit. It
   removed 28 to 29 % of cold + pan requests at the same bytes, twice the shipped
   figure. It works because a socket burst's worth of requests then register
   before the first of them claims its group; without it, the first task's
   claim races the handler loop that is still spawning its siblings. It is not
   shipped: it is a scheduler-timing hint, not a defined window, and a
   correctness-neutral one at that (its worst case is the shipped behaviour).
   The principled form is dispatching a socket burst as a group in the handler,
   so that "admitted in the same scheduling window" is something the server
   decides rather than something it happens to observe. That is a change to
   the handler, not the store, and is left as the next lever.
4. **Single client, shallow queue.** With one browser the queue depth is the
   browser's in-flight window minus the cap, a handful of reads. A second
   client, or a client past the cap for longer, deepens the queue and widens
   every group. The mechanism scales with contention, which is when a request
   saved is time saved.

---

## 3. Caveats

- One client, one dataset, one latency. The stand-in's 80 ms is a typical
  remote first byte, but it is flat; real links have tails.
- Debug builds on both sides. Request counts do not depend on it; requests per
  second within a phase might, marginally, and the same build served every
  variant.
- The opening view is a zoomed-in corner at level 0, so the phases touched 5 to 7
  shards. A full-screen fill at the target level would queue more reads per
  shard and merge more; it would also be a different workload, not this one.
- The zoom phase is not comparable run to run and is excluded above.
- The gap variant's byte figure is specific to this fixture's chunk and shard
  sizes. Larger inner chunks make the gap span fewer of them; the direction
  of the trade does not change.
