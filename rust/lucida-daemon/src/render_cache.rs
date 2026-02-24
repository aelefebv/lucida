use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::dto::view_state::PerformanceHints;

pub const DEFAULT_CPU_CACHE_BYTES: u64 = 256 * 1024 * 1024;
pub const DEFAULT_GPU_CACHE_BYTES: u64 = 512 * 1024 * 1024;
pub const ENV_MAX_CPU_CACHE_BYTES: &str = "LUCIDA_MAX_CPU_CACHE_BYTES";
pub const ENV_MAX_GPU_CACHE_BYTES: &str = "LUCIDA_MAX_GPU_CACHE_BYTES";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderCacheDefaults {
    pub max_cpu_cache_bytes: u64,
    pub max_gpu_cache_bytes: u64,
}

impl RenderCacheDefaults {
    pub fn from_env() -> Self {
        Self {
            max_cpu_cache_bytes: parse_u64_env(ENV_MAX_CPU_CACHE_BYTES, DEFAULT_CPU_CACHE_BYTES),
            max_gpu_cache_bytes: parse_u64_env(ENV_MAX_GPU_CACHE_BYTES, DEFAULT_GPU_CACHE_BYTES),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EffectiveCacheBudgets {
    pub max_cpu_cache_bytes: u64,
    pub max_gpu_cache_bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
    pub inserts: u64,
    pub evictions: u64,
    pub current_bytes: u64,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCacheSnapshot {
    pub cpu: CacheStats,
    pub gpu: CacheStats,
}

#[derive(Debug, Clone)]
struct ByteLruEntry {
    bytes: Arc<[u8]>,
    size_bytes: u64,
}

#[derive(Debug, Clone)]
struct ByteLruCache {
    entries: HashMap<String, ByteLruEntry>,
    access_order: VecDeque<String>,
    stats: CacheStats,
}

impl ByteLruCache {
    fn new(max_bytes: u64) -> Self {
        Self {
            entries: HashMap::new(),
            access_order: VecDeque::new(),
            stats: CacheStats {
                max_bytes,
                ..CacheStats::default()
            },
        }
    }

    fn snapshot(&self) -> CacheStats {
        self.stats
    }

    fn set_max_bytes(&mut self, max_bytes: u64) {
        self.stats.max_bytes = max_bytes;
        self.evict_to_fit_budget();
    }

    fn get(&mut self, key: &str) -> Option<Arc<[u8]>> {
        if let Some(entry) = self.entries.get(key) {
            let payload = entry.bytes.clone();
            self.stats.hits = self.stats.hits.saturating_add(1);
            self.touch_key(key);
            return Some(payload);
        }
        self.stats.misses = self.stats.misses.saturating_add(1);
        None
    }

    fn insert(&mut self, key: String, payload: Arc<[u8]>) {
        let size_bytes = match u64::try_from(payload.len()) {
            Ok(value) => value,
            Err(_) => return,
        };

        if self.stats.max_bytes == 0 || size_bytes > self.stats.max_bytes {
            self.clear();
            return;
        }

        if let Some(previous) = self.entries.remove(&key) {
            self.stats.current_bytes = self.stats.current_bytes.saturating_sub(previous.size_bytes);
            self.remove_from_access_order(&key);
        }

        self.access_order.push_back(key.clone());
        self.stats.current_bytes = self.stats.current_bytes.saturating_add(size_bytes);
        self.stats.inserts = self.stats.inserts.saturating_add(1);
        self.entries.insert(
            key,
            ByteLruEntry {
                bytes: payload,
                size_bytes,
            },
        );
        self.evict_to_fit_budget();
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.access_order.clear();
        self.stats.current_bytes = 0;
    }

    fn evict_to_fit_budget(&mut self) {
        while self.stats.current_bytes > self.stats.max_bytes {
            let Some(oldest_key) = self.access_order.pop_front() else {
                self.stats.current_bytes = 0;
                break;
            };
            if let Some(removed) = self.entries.remove(&oldest_key) {
                self.stats.current_bytes =
                    self.stats.current_bytes.saturating_sub(removed.size_bytes);
                self.stats.evictions = self.stats.evictions.saturating_add(1);
            }
        }
    }

    fn touch_key(&mut self, key: &str) {
        self.remove_from_access_order(key);
        self.access_order.push_back(key.to_owned());
    }

    fn remove_from_access_order(&mut self, key: &str) {
        if let Some(position) = self.access_order.iter().position(|item| item == key) {
            self.access_order.remove(position);
        }
    }
}

#[derive(Debug, Clone)]
struct SessionRenderCaches {
    cpu: ByteLruCache,
    gpu: ByteLruCache,
}

impl SessionRenderCaches {
    fn new(defaults: RenderCacheDefaults) -> Self {
        Self {
            cpu: ByteLruCache::new(defaults.max_cpu_cache_bytes),
            gpu: ByteLruCache::new(defaults.max_gpu_cache_bytes),
        }
    }

    fn configure_budgets(&mut self, budgets: EffectiveCacheBudgets) {
        self.cpu.set_max_bytes(budgets.max_cpu_cache_bytes);
        self.gpu.set_max_bytes(budgets.max_gpu_cache_bytes);
    }
}

#[derive(Debug)]
pub struct RenderCacheRegistry {
    defaults: RenderCacheDefaults,
    sessions: HashMap<String, SessionRenderCaches>,
}

impl Default for RenderCacheRegistry {
    fn default() -> Self {
        Self {
            defaults: RenderCacheDefaults::from_env(),
            sessions: HashMap::new(),
        }
    }
}

impl RenderCacheRegistry {
    pub fn defaults(&self) -> RenderCacheDefaults {
        self.defaults
    }

    pub fn resolve_effective_budgets(
        &self,
        performance: Option<&PerformanceHints>,
    ) -> EffectiveCacheBudgets {
        EffectiveCacheBudgets {
            max_cpu_cache_bytes: performance
                .and_then(|hints| hints.max_cpu_cache_bytes)
                .unwrap_or(self.defaults.max_cpu_cache_bytes),
            max_gpu_cache_bytes: performance
                .and_then(|hints| hints.max_gpu_cache_bytes)
                .unwrap_or(self.defaults.max_gpu_cache_bytes),
        }
    }

    pub fn ensure_session_budgets(&mut self, session_id: &str, budgets: EffectiveCacheBudgets) {
        let caches = self
            .sessions
            .entry(session_id.to_owned())
            .or_insert_with(|| SessionRenderCaches::new(self.defaults));
        caches.configure_budgets(budgets);
    }

    pub fn get_cpu_chunk(&mut self, session_id: &str, key: &str) -> Option<Arc<[u8]>> {
        self.sessions
            .get_mut(session_id)
            .and_then(|session| session.cpu.get(key))
    }

    pub fn put_cpu_chunk(&mut self, session_id: &str, key: String, payload: Arc<[u8]>) {
        let caches = self
            .sessions
            .entry(session_id.to_owned())
            .or_insert_with(|| SessionRenderCaches::new(self.defaults));
        caches.cpu.insert(key, payload);
    }

    pub fn session_snapshot(&self, session_id: &str) -> Option<SessionCacheSnapshot> {
        self.sessions
            .get(session_id)
            .map(|session| SessionCacheSnapshot {
                cpu: session.cpu.snapshot(),
                gpu: session.gpu.snapshot(),
            })
    }

    pub fn session_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.sessions.keys().cloned().collect();
        ids.sort();
        ids
    }
}

pub type SharedRenderCacheRegistry = Arc<RwLock<RenderCacheRegistry>>;

pub fn new_shared_render_cache_registry() -> SharedRenderCacheRegistry {
    Arc::new(RwLock::new(RenderCacheRegistry::default()))
}

fn parse_u64_env(name: &str, fallback: u64) -> u64 {
    match std::env::var(name) {
        Ok(value) => value.parse::<u64>().unwrap_or(fallback),
        Err(_) => fallback,
    }
}
