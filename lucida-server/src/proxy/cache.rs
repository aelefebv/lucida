//! On-disk proxy cache.
//!
//! Layout: `{root_dir}/{url_hash hex}/{entity_id}/{kind}/T{t:05}_C{c:03}.bin`.
//!
//! Each file holds a 64-byte [`ProxyHeader`] followed by little-endian
//! `u16` voxels (Z, Y, X row-major; X varies fastest). On read we verify
//! the header's algorithm version (rejected by `lucida_proxy::read_header`
//! itself) and the expected `source_content_hash`; mismatches are treated
//! as cache misses so stale entries get regenerated on demand.
//!
//! Writes are atomic: data is written to a uniquely-named temp file in the
//! same directory, fsynced, then renamed into place. A crash mid-write
//! leaves a `.tmp.*` leftover but never a half-written final file.
//!
//! ## Read-only / unwritable filesystems
//!
//! Construct the cache with [`ProxyCache::new_disabled`] (or detect the
//! failure on [`ProxyCache::new`]) to get a no-op cache that always returns
//! `Ok(None)` on read and silently no-ops writes. The server uses this so
//! it can boot even when the configured cache directory is unwritable.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use lucida_proxy::{ProxyAsset, ProxyDtype, ProxyKind, ProxySpec, read_header, write_header};

/// On-disk cache for generated proxies, scoped to a single dataset by
/// `url_hash`.
pub struct ProxyCache {
    root_dir: PathBuf,
    url_hash: [u8; 16],
    /// Disabled caches no-op on writes and miss on reads. Set when the
    /// configured root is on a read-only / unwritable filesystem so the
    /// server can still boot.
    disabled: bool,
    /// Counter mixed into temp file names so concurrent writers within one
    /// process never collide.
    tmp_counter: AtomicU64,
}

impl ProxyCache {
    /// Build a cache rooted at `root_dir`, scoped to the dataset whose URL
    /// hashes to `url_hash`.
    ///
    /// Attempts to create `root_dir` if missing. On failure (read-only FS,
    /// permissions, etc.) returns a [`ProxyCache::new_disabled`]-equivalent
    /// instance so the server can still boot — the caller should log a
    /// warning, but no further error handling is required.
    pub fn new(root_dir: PathBuf, url_hash: [u8; 16]) -> Self {
        let disabled = match fs::create_dir_all(&root_dir) {
            Ok(()) => false,
            Err(e) => {
                tracing::warn!(
                    root = %root_dir.display(),
                    error = %e,
                    "proxy cache root unwritable; cache disabled"
                );
                true
            }
        };
        Self {
            root_dir,
            url_hash,
            disabled,
            tmp_counter: AtomicU64::new(0),
        }
    }

    /// Build a no-op cache (`get` always misses, `put` is silently dropped).
    /// Useful when the configured cache directory is unavailable.
    pub fn new_disabled(root_dir: PathBuf, url_hash: [u8; 16]) -> Self {
        Self {
            root_dir,
            url_hash,
            disabled: true,
            tmp_counter: AtomicU64::new(0),
        }
    }

    /// True if this cache will silently drop writes and miss on reads.
    pub fn is_disabled(&self) -> bool {
        self.disabled
    }

    /// Dataset-scoped subdirectory. Public for `clear_dataset` callers and
    /// for tests.
    pub fn dataset_dir(&self) -> PathBuf {
        self.root_dir.join(hex16(&self.url_hash))
    }

    /// Path to the file that *would* hold `spec`, regardless of whether it
    /// exists. Public so tests can poke at it.
    pub fn spec_path(&self, spec: &ProxySpec) -> PathBuf {
        self.dataset_dir()
            .join(sanitize_segment(&spec.entity_id.0))
            .join(kind_segment(spec.kind))
            .join(format!("T{:05}_C{:03}.bin", spec.t, spec.c))
    }

    /// Read a cached asset for `spec`, returning `Ok(None)` if:
    /// - the file does not exist, or
    /// - the header's algorithm version is rejected by `read_header`, or
    /// - the header's `source_content_hash` differs from
    ///   `expected_source_hash` (stale).
    ///
    /// Other I/O errors propagate.
    pub fn get(
        &self,
        spec: &ProxySpec,
        expected_source_hash: &[u8; 32],
    ) -> io::Result<Option<ProxyAsset>> {
        if self.disabled {
            return Ok(None);
        }

        let path = self.spec_path(spec);
        let file = match File::open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };

        let mut reader = BufReader::new(file);
        let header = match read_header(&mut reader) {
            Ok(h) => h,
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                // Bad magic, version mismatch, or unknown dtype — treat as
                // a miss so the caller regenerates.
                tracing::debug!(
                    path = %path.display(),
                    error = %e,
                    "proxy cache header rejected; treating as miss"
                );
                return Ok(None);
            }
            Err(e) => return Err(e),
        };

        if &header.source_content_hash != expected_source_hash {
            tracing::debug!(
                path = %path.display(),
                "proxy cache source-hash mismatch; treating as miss"
            );
            return Ok(None);
        }

        let voxel_count = (header.dims[0] as usize)
            .saturating_mul(header.dims[1] as usize)
            .saturating_mul(header.dims[2] as usize);

        // Currently only U16 is defined; this match keeps us future-proof.
        let voxels = match header.dtype {
            ProxyDtype::U16 => read_u16_voxels(&mut reader, voxel_count)?,
        };

        Ok(Some(ProxyAsset { header, voxels }))
    }

    /// Atomically write `asset` to `spec`'s cache path.
    ///
    /// Strategy:
    /// 1. Build the parent directory tree if missing.
    /// 2. Write to `{path}.tmp.{counter}.{rand}` in the same directory.
    /// 3. fsync the temp file.
    /// 4. Rename into place (atomic on POSIX).
    /// 5. Best-effort fsync of the parent directory.
    pub fn put(&self, spec: &ProxySpec, asset: &ProxyAsset) -> io::Result<()> {
        if self.disabled {
            return Ok(());
        }

        let path = self.spec_path(spec);
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "proxy path has no parent")
        })?;
        fs::create_dir_all(parent)?;

        let counter = self.tmp_counter.fetch_add(1, Ordering::Relaxed);
        let rand: u64 = rand::random();
        let file_name = path
            .file_name()
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "proxy path has no file name")
            })?
            .to_string_lossy()
            .to_string();
        let tmp_path = parent.join(format!(".{file_name}.tmp.{counter}.{rand:016x}"));

        // Scope the writer so the file is closed (and hence fsync-able)
        // before we rename.
        {
            let file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&tmp_path)?;
            let mut writer = BufWriter::new(&file);
            write_header(&mut writer, &asset.header)?;
            write_u16_voxels(&mut writer, &asset.voxels)?;
            writer.flush()?;
            file.sync_all()?;
        }

        match fs::rename(&tmp_path, &path) {
            Ok(()) => {}
            Err(e) => {
                // Best effort: clean up the leftover temp file.
                let _ = fs::remove_file(&tmp_path);
                return Err(e);
            }
        }

        // Best-effort directory fsync. Failing here doesn't invalidate the
        // write — the rename succeeded — so we ignore errors.
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }

        Ok(())
    }

    /// Whether a file exists at the spec's cache path. **Does not** verify
    /// the header — callers should use [`Self::get`] to confirm freshness.
    pub fn exists(&self, spec: &ProxySpec) -> bool {
        if self.disabled {
            return false;
        }
        self.spec_path(spec).exists()
    }

    /// Recursively remove the per-dataset subdirectory (`{root}/{hash}`).
    /// No-op if the directory is missing.
    pub fn clear_dataset(&self) -> io::Result<()> {
        if self.disabled {
            return Ok(());
        }
        let dir = self.dataset_dir();
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// Hex-encode a 16-byte hash for use as a cache directory name. Lowercase,
/// no separators — matches the `dataset_id_for_url` style.
fn hex16(bytes: &[u8; 16]) -> String {
    let mut out = String::with_capacity(32);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Stable, filesystem-safe identifier for a `ProxyKind`. We pin it
/// explicitly rather than using `Debug` so that renaming an enum variant
/// does not silently invalidate the on-disk layout.
fn kind_segment(kind: ProxyKind) -> &'static str {
    match kind {
        ProxyKind::FieldProxy3D => "field3d",
        ProxyKind::WellProxy3D => "well3d",
    }
}

/// Sanitize an arbitrary EntityId for use as a single path segment: keeps
/// alphanumerics, dashes, underscores, and dots; replaces everything else
/// with `_`. Long IDs are kept (we trust the import pipeline's IDs are
/// reasonable).
fn sanitize_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}

fn read_u16_voxels<R: Read>(r: &mut R, count: usize) -> io::Result<Vec<u16>> {
    let mut bytes = vec![0u8; count * 2];
    r.read_exact(&mut bytes)?;
    let mut out = vec![0u16; count];
    for (i, chunk) in bytes.chunks_exact(2).enumerate() {
        out[i] = u16::from_le_bytes([chunk[0], chunk[1]]);
    }
    Ok(out)
}

fn write_u16_voxels<W: Write>(w: &mut W, voxels: &[u16]) -> io::Result<()> {
    // Buffer the conversion so we issue one large write per chunk of work.
    const CHUNK: usize = 4096;
    let mut buf = [0u8; CHUNK * 2];
    for chunk in voxels.chunks(CHUNK) {
        for (i, v) in chunk.iter().enumerate() {
            let bytes = v.to_le_bytes();
            buf[i * 2] = bytes[0];
            buf[i * 2 + 1] = bytes[1];
        }
        w.write_all(&buf[..chunk.len() * 2])?;
    }
    Ok(())
}
