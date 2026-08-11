//! Concurrency sweep against a real remote object store (issue #901).
//!
//! Answers one question the full browser harness is too slow and too noisy to
//! answer: **as concurrent source reads rise, where does aggregate throughput
//! stop improving and where does the store start pushing back?** That knee is
//! what the source-read permit count should be sized on.
//!
//! It reads real objects out of the same bucket the viewer reads, through the
//! same `object_store` version and the same credential discovery, so the
//! transport (HTTP/2 stream multiplexing to one host, connection reuse, GCS
//! per-connection behaviour) is production's transport.
//!
//! Two properties matter for trusting the output:
//!
//! * **Every read is of a distinct object, once.** No object is fetched twice
//!   in a run, so nothing is served from a GCS edge cache warmed by the sweep
//!   itself.
//! * **Levels are interleaved across passes, not run back to back.** Remote
//!   latency drifts by ~2x between sessions (see `remote-rates.md` §0), which
//!   is larger than the effect being measured. Each pass visits every level in
//!   a rotated order, so drift hits all levels roughly equally and the
//!   per-level medians are taken across passes.
//!
//! Usage:
//!
//! ```text
//! cargo run --release -- gs://bucket/prefix.zarr [--levels 4,8,12,...] \
//!     [--per-cell 120] [--passes 4]
//! ```

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use futures_util::StreamExt;
use object_store::path::Path;
use object_store::{ObjectStore, gcp::GoogleCloudStorageBuilder};

/// One completed read.
#[derive(Clone, Copy)]
struct Read {
    ttfb_us: u128,
    body_us: u128,
    bytes: usize,
    ok: bool,
}

/// One (level, pass) cell: `per_cell` distinct objects read at `level` in flight.
struct Cell {
    level: usize,
    pass: usize,
    wall_us: u128,
    reads: Vec<Read>,
}

impl Cell {
    fn ok_reads(&self) -> Vec<&Read> {
        self.reads.iter().filter(|r| r.ok).collect()
    }

    /// Completed reads per second for the cell, the throughput figure the
    /// permit count is ultimately chosen on.
    fn reads_per_s(&self) -> f64 {
        self.ok_reads().len() as f64 / (self.wall_us as f64 / 1_000_000.0)
    }

    fn mib_per_s(&self) -> f64 {
        let bytes: usize = self.ok_reads().iter().map(|r| r.bytes).sum();
        (bytes as f64 / 1_048_576.0) / (self.wall_us as f64 / 1_000_000.0)
    }
}

fn pct(sorted: &[u128], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[idx] as f64 / 1000.0
}

fn median_f(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return f64::NAN;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    values[values.len() / 2]
}

fn parse_gs(url: &str) -> (String, Option<String>) {
    let rest = url.trim_start_matches("gs://");
    match rest.split_once('/') {
        Some((bucket, prefix)) => (bucket.to_string(), Some(prefix.trim_end_matches('/').to_string())),
        None => (rest.to_string(), None),
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let url = args.next().unwrap_or_else(|| {
        eprintln!("usage: source-read-sweep gs://bucket/prefix [--levels ..] [--per-cell N] [--passes N]");
        std::process::exit(2);
    });

    let mut levels: Vec<usize> = vec![1, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128];
    let mut per_cell: usize = 120;
    let mut passes: usize = 4;
    // Default size band: the interactive read profile measured in
    // `remote-rates.md` §3 is p50 326 KiB per source read. Base-level chunks in
    // the same bucket are ~5 MB and would turn a concurrency sweep into a
    // bandwidth test, so the band keeps the sample on the reads whose queueing
    // the permit count actually governs.
    let mut min_bytes: usize = 64 * 1024;
    let mut max_bytes: usize = 1024 * 1024;
    while let Some(flag) = args.next() {
        let value = args.next().unwrap_or_default();
        match flag.as_str() {
            "--levels" => {
                levels = value
                    .split(',')
                    .filter_map(|v| v.trim().parse().ok())
                    .collect()
            }
            "--per-cell" => per_cell = value.parse().expect("--per-cell wants a number"),
            "--passes" => passes = value.parse().expect("--passes wants a number"),
            "--min-bytes" => min_bytes = value.parse().expect("--min-bytes wants a number"),
            "--max-bytes" => max_bytes = value.parse().expect("--max-bytes wants a number"),
            other => {
                eprintln!("unknown flag {other}");
                std::process::exit(2);
            }
        }
    }

    let (bucket, prefix) = parse_gs(&url);
    let store: Arc<dyn ObjectStore> = Arc::new(
        GoogleCloudStorageBuilder::from_env()
            .with_bucket_name(&bucket)
            .build()
            .expect("build gcs store"),
    );

    // Distinct objects needed for the whole run, one read each.
    let wanted = levels.len() * per_cell * passes;
    let root = prefix.as_deref().map(Path::from);

    // Spread the sample across members rather than reading straight down one
    // prefix. A grid collection stores each member under its own key prefix,
    // and object stores shard by key range: hammering one prefix measures one
    // shard's behaviour, not the store's. Two delimiter walks (root -> rows,
    // row -> columns) enumerate the members for ~25 requests.
    eprintln!("[sweep] enumerating members under {url}");
    let rows = store
        .list_with_delimiter(root.as_ref())
        .await
        .expect("list rows")
        .common_prefixes;
    let mut members: Vec<Path> = Vec::new();
    for row in &rows {
        let cols = store
            .list_with_delimiter(Some(row))
            .await
            .expect("list columns")
            .common_prefixes;
        members.extend(cols);
    }
    eprintln!("[sweep] {} rows, {} members", rows.len(), members.len());
    if members.is_empty() {
        eprintln!("[sweep] FATAL: no members under {url}");
        std::process::exit(2);
    }

    // Round-robin the members so consecutive reads in a cell land on different
    // prefixes, the way a pan across a grid does.
    let per_member = wanted.div_ceil(members.len()).max(1);
    eprintln!("[sweep] collecting {wanted} objects ({per_member} per member, {min_bytes}..{max_bytes} bytes)");
    let mut by_member: Vec<Vec<(Path, usize)>> = Vec::with_capacity(members.len());
    for member in &members {
        let mut picked: Vec<(Path, usize)> = Vec::with_capacity(per_member);
        let mut listing = store.list(Some(member));
        while let Some(item) = listing.next().await {
            let meta = item.expect("list objects");
            // Chunk objects only: metadata is a different read class with a
            // different size profile and its own separate cap.
            if meta.location.filename().is_some_and(|f| f.ends_with(".json")) {
                continue;
            }
            let size = meta.size as usize;
            if size < min_bytes || size > max_bytes {
                continue;
            }
            picked.push((meta.location, size));
            if picked.len() >= per_member {
                break;
            }
        }
        by_member.push(picked);
        if by_member.iter().map(Vec::len).sum::<usize>() >= wanted {
            break;
        }
    }

    let mut paths: Vec<(Path, usize)> = Vec::with_capacity(wanted);
    for index in 0..per_member {
        for member_objects in &by_member {
            if let Some(entry) = member_objects.get(index) {
                paths.push(entry.clone());
            }
        }
    }
    paths.truncate(wanted);
    let sampled_members = by_member.iter().filter(|m| !m.is_empty()).count();
    let mut sizes: Vec<u128> = paths.iter().map(|(_, s)| *s as u128).collect();
    sizes.sort_unstable();
    eprintln!(
        "[sweep] {} objects across {} members, size p50 {:.0} KiB",
        paths.len(),
        sampled_members,
        pct(&sizes, 0.50) * 1000.0 / 1024.0
    );
    if paths.len() < wanted {
        eprintln!("[sweep] FATAL: wanted {wanted} distinct objects, found {}", paths.len());
        std::process::exit(2);
    }

    let mut next_object = 0usize;
    let mut cells: Vec<Cell> = Vec::new();

    for pass in 0..passes {
        // Rotate the level order each pass so no level is systematically
        // measured early (cold connection) or late (drifted network).
        let mut order: Vec<usize> = levels.clone();
        order.rotate_left(pass % levels.len());
        for level in order {
            let slice: Vec<(Path, usize)> = paths[next_object..next_object + per_cell].to_vec();
            next_object += per_cell;

            let in_flight = Arc::new(AtomicUsize::new(0));
            let peak = Arc::new(AtomicUsize::new(0));
            let started = Instant::now();
            let reads: Vec<Read> = futures_util::stream::iter(slice.into_iter().map(|(path, _)| {
                let store = store.clone();
                let in_flight = in_flight.clone();
                let peak = peak.clone();
                async move {
                    let now = in_flight.fetch_add(1, Ordering::Relaxed) + 1;
                    peak.fetch_max(now, Ordering::Relaxed);
                    let t0 = Instant::now();
                    let read = match store.get(&path).await {
                        Ok(object) => {
                            let ttfb_us = t0.elapsed().as_micros();
                            let t1 = Instant::now();
                            match object.bytes().await {
                                Ok(bytes) => Read {
                                    ttfb_us,
                                    body_us: t1.elapsed().as_micros(),
                                    bytes: bytes.len(),
                                    ok: true,
                                },
                                Err(_) => Read { ttfb_us, body_us: 0, bytes: 0, ok: false },
                            }
                        }
                        Err(_) => Read {
                            ttfb_us: t0.elapsed().as_micros(),
                            body_us: 0,
                            bytes: 0,
                            ok: false,
                        },
                    };
                    in_flight.fetch_sub(1, Ordering::Relaxed);
                    read
                }
            }))
            .buffer_unordered(level)
            .collect()
            .await;

            let cell = Cell { level, pass, wall_us: started.elapsed().as_micros(), reads };
            eprintln!(
                "[sweep] pass {pass} level {level:>3}: {:.1} reads/s  {:.1} MiB/s  peak in-flight {}  errors {}",
                cell.reads_per_s(),
                cell.mib_per_s(),
                peak.load(Ordering::Relaxed),
                cell.reads.iter().filter(|r| !r.ok).count(),
            );
            cells.push(cell);
        }
    }

    // Per-level summary: throughput as the median across passes (drift-robust),
    // latency pooled over every read at that level.
    println!("\n# source-read concurrency sweep — {url}");
    println!("# {per_cell} distinct objects per cell, {passes} passes, levels interleaved\n");
    println!("| level | reads/s (median of passes) | MiB/s | TTFB p50 ms | TTFB p95 ms | body p50 ms | body p95 ms | n | err |");
    println!("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for level in &levels {
        let at: Vec<&Cell> = cells.iter().filter(|c| c.level == *level).collect();
        let mut ttfb: Vec<u128> = at.iter().flat_map(|c| c.ok_reads()).map(|r| r.ttfb_us).collect();
        let mut body: Vec<u128> = at.iter().flat_map(|c| c.ok_reads()).map(|r| r.body_us).collect();
        ttfb.sort_unstable();
        body.sort_unstable();
        let errors: usize = at.iter().map(|c| c.reads.iter().filter(|r| !r.ok).count()).sum();
        println!(
            "| {level} | {:.1} | {:.1} | {:.1} | {:.1} | {:.1} | {:.1} | {} | {} |",
            median_f(at.iter().map(|c| c.reads_per_s()).collect()),
            median_f(at.iter().map(|c| c.mib_per_s()).collect()),
            pct(&ttfb, 0.50),
            pct(&ttfb, 0.95),
            pct(&body, 0.50),
            pct(&body, 0.95),
            ttfb.len(),
            errors,
        );
    }

    // Raw per-cell rows, so a reader can see the pass-to-pass spread rather
    // than trusting the median alone.
    println!("\n## per-cell\n");
    println!("| pass | level | reads/s | MiB/s | wall s |");
    println!("| --- | --- | --- | --- | --- |");
    for cell in &cells {
        println!(
            "| {} | {} | {:.1} | {:.1} | {:.2} |",
            cell.pass,
            cell.level,
            cell.reads_per_s(),
            cell.mib_per_s(),
            cell.wall_us as f64 / 1_000_000.0
        );
    }
}
