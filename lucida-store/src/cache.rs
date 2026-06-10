//! Memory-bounded LRU Chunk Cache wrapping a StorageBackend.
//!
//! Caches chunk bytes fetched from an ObjectStore to reduce repeated reads
//! when multiple Clients view the same region.

use std::sync::Arc;
use std::sync::Mutex;

use bytes::Bytes;
use lru::LruCache;
use object_store::ObjectStore;
use object_store::path::Path;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CacheStats {
    pub max_bytes: usize,
    pub current_bytes: usize,
    pub entry_count: usize,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub backend_errors: u64,
}

/// A memory-bounded LRU cache wrapping an ObjectStore.
pub struct CachedStore {
    inner: Arc<dyn ObjectStore>,
    cache: Mutex<LruState>,
}

struct LruState {
    lru: LruCache<String, Bytes>,
    current_bytes: usize,
    max_bytes: usize,
    hits: u64,
    misses: u64,
    evictions: u64,
    backend_errors: u64,
}

impl CachedStore {
    /// Create a new CachedStore wrapping `inner` with a maximum cache size of `max_bytes`.
    pub fn new(inner: Arc<dyn ObjectStore>, max_bytes: usize) -> Self {
        Self {
            inner,
            cache: Mutex::new(LruState {
                lru: LruCache::unbounded(),
                current_bytes: 0,
                max_bytes,
                hits: 0,
                misses: 0,
                evictions: 0,
                backend_errors: 0,
            }),
        }
    }

    pub fn stats(&self) -> CacheStats {
        let state = self.cache.lock().unwrap();
        CacheStats {
            max_bytes: state.max_bytes,
            current_bytes: state.current_bytes,
            entry_count: state.lru.len(),
            hits: state.hits,
            misses: state.misses,
            evictions: state.evictions,
            backend_errors: state.backend_errors,
        }
    }

    /// Get bytes by path, returning cached data on hit or fetching from the inner store on miss.
    pub async fn get_bytes(&self, path: &Path) -> Result<Bytes, object_store::Error> {
        let key = path.to_string();

        // Check cache
        {
            let mut state = self.cache.lock().unwrap();
            if let Some(bytes) = state.lru.get(&key) {
                let bytes = bytes.clone();
                state.hits += 1;
                return Ok(bytes);
            }
            state.misses += 1;
        }

        // Cache miss — fetch from inner store
        let bytes = match self.inner.get(path).await {
            Ok(object) => match object.bytes().await {
                Ok(bytes) => bytes,
                Err(error) => {
                    let mut state = self.cache.lock().unwrap();
                    state.backend_errors += 1;
                    return Err(error);
                }
            },
            Err(error) => {
                let mut state = self.cache.lock().unwrap();
                state.backend_errors += 1;
                return Err(error);
            }
        };

        // Insert into cache, evict LRU entries if over budget
        {
            let mut state = self.cache.lock().unwrap();
            if let Some(bytes) = state.lru.get(&key) {
                return Ok(bytes.clone());
            }
            let new_size = bytes.len();

            while state.current_bytes + new_size > state.max_bytes {
                match state.lru.pop_lru() {
                    Some((_, evicted)) => {
                        state.current_bytes -= evicted.len();
                        state.evictions += 1;
                    }
                    None => break,
                }
            }

            state.current_bytes += new_size;
            state.lru.put(key, bytes.clone());
        }

        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("lucida_cache_test_{}", std::process::id()))
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn cache_hit_returns_same_bytes() {
        let dir = temp_dir("hit");
        fs::write(dir.join("chunk1"), b"hello world").unwrap();

        let inner = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let cached = CachedStore::new(inner, 1024);

        let path = Path::from("chunk1");
        let first = cached.get_bytes(&path).await.unwrap();
        let second = cached.get_bytes(&path).await.unwrap();
        assert_eq!(first, second);
        assert_eq!(&first[..], b"hello world");
        let stats = cached.stats();
        assert_eq!(stats.hits, 1);
        assert_eq!(stats.misses, 1);
        assert_eq!(stats.entry_count, 1);
        assert_eq!(stats.current_bytes, b"hello world".len());

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn eviction_on_budget_exceeded() {
        let dir = temp_dir("evict");
        fs::write(dir.join("a"), vec![0u8; 60]).unwrap();
        fs::write(dir.join("b"), vec![1u8; 60]).unwrap();

        // Cache budget = 100 bytes. Each chunk is 60 bytes.
        let inner = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let cached = CachedStore::new(inner, 100);

        let pa = Path::from("a");
        let pb = Path::from("b");

        let _a = cached.get_bytes(&pa).await.unwrap();
        let _b = cached.get_bytes(&pb).await.unwrap();

        // "a" should have been evicted to make room for "b"
        {
            let state = cached.cache.lock().unwrap();
            assert!(state.current_bytes <= 100);
            assert_eq!(state.lru.len(), 1);
        }
        let stats = cached.stats();
        assert_eq!(stats.evictions, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_file_returns_error() {
        let dir = temp_dir("missing");

        let inner = crate::backend::open(dir.to_str().unwrap()).unwrap();
        let cached = CachedStore::new(inner, 1024);

        let result = cached.get_bytes(&Path::from("nonexistent")).await;
        assert!(result.is_err());
        let stats = cached.stats();
        assert_eq!(stats.backend_errors, 1);

        let _ = fs::remove_dir_all(&dir);
    }
}
