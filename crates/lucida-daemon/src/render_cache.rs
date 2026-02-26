use std::collections::HashMap;
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
    prev: Option<Arc<str>>,
    next: Option<Arc<str>>,
    bytes: Arc<[u8]>,
    size_bytes: u64,
}

#[derive(Debug, Clone)]
struct ByteLruCache {
    entries: HashMap<Arc<str>, ByteLruEntry>,
    oldest_key: Option<Arc<str>>,
    newest_key: Option<Arc<str>>,
    stats: CacheStats,
}

impl ByteLruCache {
    fn new(max_bytes: u64) -> Self {
        Self {
            entries: HashMap::new(),
            oldest_key: None,
            newest_key: None,
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

        let key = Arc::<str>::from(key);
        if let Some(previous) = self.remove_entry(key.as_ref()) {
            self.stats.current_bytes = self.stats.current_bytes.saturating_sub(previous.size_bytes);
        }

        let previous_newest = self.newest_key.clone();
        let entry = ByteLruEntry {
            prev: previous_newest.clone(),
            next: None,
            bytes: payload,
            size_bytes,
        };
        self.entries.insert(key.clone(), entry);
        if let Some(previous_newest) = previous_newest {
            if let Some(previous_entry) = self.entries.get_mut(previous_newest.as_ref()) {
                previous_entry.next = Some(key.clone());
            }
        } else {
            self.oldest_key = Some(key.clone());
        }
        self.newest_key = Some(key);
        self.stats.current_bytes = self.stats.current_bytes.saturating_add(size_bytes);
        self.stats.inserts = self.stats.inserts.saturating_add(1);
        self.evict_to_fit_budget();
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.oldest_key = None;
        self.newest_key = None;
        self.stats.current_bytes = 0;
    }

    fn evict_to_fit_budget(&mut self) {
        while self.stats.current_bytes > self.stats.max_bytes {
            let Some(oldest_key) = self.oldest_key.clone() else {
                self.stats.current_bytes = 0;
                break;
            };
            if let Some(removed) = self.remove_entry(oldest_key.as_ref()) {
                self.stats.current_bytes =
                    self.stats.current_bytes.saturating_sub(removed.size_bytes);
                self.stats.evictions = self.stats.evictions.saturating_add(1);
            }
        }
    }

    fn touch_key(&mut self, key: &str) {
        if self.newest_key.as_deref() == Some(key) {
            return;
        }
        if !self.entries.contains_key(key) {
            return;
        }

        self.detach_entry(key);
        let Some(current_key) = self
            .entries
            .get_key_value(key)
            .map(|(stored_key, _)| stored_key.clone())
        else {
            return;
        };
        let previous_newest = self.newest_key.clone();
        if let Some(previous_newest) = previous_newest.as_ref() {
            if let Some(previous_entry) = self.entries.get_mut(previous_newest.as_ref()) {
                previous_entry.next = Some(current_key.clone());
            }
        } else {
            self.oldest_key = Some(current_key.clone());
        }
        if let Some(current_entry) = self.entries.get_mut(key) {
            current_entry.prev = previous_newest;
            current_entry.next = None;
        }
        self.newest_key = Some(current_key);
    }

    fn remove_entry(&mut self, key: &str) -> Option<ByteLruEntry> {
        if !self.entries.contains_key(key) {
            return None;
        }
        self.detach_entry(key);
        self.entries.remove(key)
    }

    fn detach_entry(&mut self, key: &str) {
        let (previous_key, next_key) = match self.entries.get(key) {
            Some(entry) => (entry.prev.clone(), entry.next.clone()),
            None => return,
        };

        if let Some(previous_key) = previous_key.as_ref() {
            if let Some(previous_entry) = self.entries.get_mut(previous_key.as_ref()) {
                previous_entry.next = next_key.clone();
            }
        } else {
            self.oldest_key = next_key.clone();
        }

        if let Some(next_key) = next_key.as_ref() {
            if let Some(next_entry) = self.entries.get_mut(next_key.as_ref()) {
                next_entry.prev = previous_key.clone();
            }
        } else {
            self.newest_key = previous_key.clone();
        }

        if let Some(entry) = self.entries.get_mut(key) {
            entry.prev = None;
            entry.next = None;
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

#[cfg(test)]
mod tests {
    use super::ByteLruCache;
    use std::sync::Arc;

    fn payload(byte_count: usize, value: u8) -> Arc<[u8]> {
        vec![value; byte_count].into()
    }

    fn lru_order(cache: &ByteLruCache) -> Vec<String> {
        let mut order = Vec::new();
        let mut cursor = cache.oldest_key.clone();
        let mut visited = 0_usize;
        while let Some(key) = cursor {
            visited = visited.saturating_add(1);
            assert!(visited <= cache.entries.len().saturating_add(1));
            order.push(key.to_string());
            cursor = cache
                .entries
                .get(key.as_ref())
                .and_then(|entry| entry.next.clone());
        }
        order
    }

    #[test]
    fn hit_promotes_entry_to_mru_for_eviction_order() {
        let mut cache = ByteLruCache::new(6);
        cache.insert("a".to_owned(), payload(2, 1));
        cache.insert("b".to_owned(), payload(2, 2));
        cache.insert("c".to_owned(), payload(2, 3));
        assert_eq!(lru_order(&cache), vec!["a", "b", "c"]);

        assert!(cache.get("a").is_some());
        assert_eq!(lru_order(&cache), vec!["b", "c", "a"]);

        cache.insert("d".to_owned(), payload(2, 4));
        assert_eq!(lru_order(&cache), vec!["c", "a", "d"]);
        assert!(cache.get("b").is_none());
        assert_eq!(cache.stats.evictions, 1);
    }

    #[test]
    fn replacing_entry_keeps_single_lru_node_and_updates_size() {
        let mut cache = ByteLruCache::new(6);
        cache.insert("a".to_owned(), payload(2, 1));
        cache.insert("b".to_owned(), payload(2, 2));
        cache.insert("a".to_owned(), payload(3, 3));
        assert_eq!(cache.stats.current_bytes, 5);
        assert_eq!(lru_order(&cache), vec!["b", "a"]);

        cache.insert("c".to_owned(), payload(2, 4));
        assert!(cache.get("b").is_none());
        assert!(cache.get("a").is_some());
        assert!(cache.get("c").is_some());
        assert_eq!(cache.stats.current_bytes, 5);
        assert_eq!(cache.stats.evictions, 1);
    }

    #[test]
    fn oversize_insert_clears_existing_entries() {
        let mut cache = ByteLruCache::new(4);
        cache.insert("a".to_owned(), payload(2, 1));
        cache.insert("b".to_owned(), payload(2, 2));
        assert_eq!(cache.stats.current_bytes, 4);

        cache.insert("c".to_owned(), payload(5, 3));
        assert_eq!(cache.stats.current_bytes, 0);
        assert!(cache.get("a").is_none());
        assert!(cache.get("b").is_none());
        assert!(cache.get("c").is_none());
        assert!(lru_order(&cache).is_empty());
    }
}
