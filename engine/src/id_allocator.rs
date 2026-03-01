use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum IdKind {
    Session,
    Client,
    Scene,
    Source,
    Dataset,
    Layer,
    Target,
    Generation,
    Recipe,
    PublishBatch,
    Token,
    ContextPackage,
}

impl IdKind {
    const fn prefix(self) -> &'static str {
        match self {
            IdKind::Session => "sess",
            IdKind::Client => "cli",
            IdKind::Scene => "scn",
            IdKind::Source => "src",
            IdKind::Dataset => "ds",
            IdKind::Layer => "lay",
            IdKind::Target => "tgt",
            IdKind::Generation => "gen",
            IdKind::Recipe => "rr",
            IdKind::PublishBatch => "pub",
            IdKind::Token => "tok",
            IdKind::ContextPackage => "lcp",
        }
    }

    const fn all() -> [Self; 12] {
        [
            Self::Session,
            Self::Client,
            Self::Scene,
            Self::Source,
            Self::Dataset,
            Self::Layer,
            Self::Target,
            Self::Generation,
            Self::Recipe,
            Self::PublishBatch,
            Self::Token,
            Self::ContextPackage,
        ]
    }
}

#[derive(Debug, Default)]
pub struct IdAllocator {
    counters: BTreeMap<IdKind, u64>,
    persistence_path: Option<PathBuf>,
}

impl IdAllocator {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_persistence(path: PathBuf) -> Self {
        let counters = load_counters(&path);
        Self {
            counters,
            persistence_path: Some(path),
        }
    }

    pub fn allocate(&mut self, kind: IdKind) -> String {
        let next_counter = {
            let counter = self.counters.entry(kind).or_insert(0);
            *counter += 1;
            *counter
        };
        self.persist_best_effort();
        format!("{}_{next_counter:08}", kind.prefix())
    }

    fn persist_best_effort(&self) {
        let Some(path) = self.persistence_path.as_deref() else {
            return;
        };
        let _ = persist_counters(path, &self.counters);
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PersistedCounters {
    counters: BTreeMap<String, u64>,
}

fn load_counters(path: &Path) -> BTreeMap<IdKind, u64> {
    let bytes = match std::fs::read(path) {
        Ok(value) => value,
        Err(_) => return BTreeMap::new(),
    };
    let persisted = match serde_json::from_slice::<PersistedCounters>(&bytes) {
        Ok(value) => value,
        Err(_) => return BTreeMap::new(),
    };

    let mut counters = BTreeMap::new();
    for kind in IdKind::all() {
        if let Some(value) = persisted.counters.get(kind.prefix()) {
            counters.insert(kind, *value);
        }
    }
    counters
}

fn persist_counters(path: &Path, counters: &BTreeMap<IdKind, u64>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let persisted = PersistedCounters {
        counters: IdKind::all()
            .into_iter()
            .map(|kind| {
                let value = counters.get(&kind).copied().unwrap_or(0);
                (kind.prefix().to_owned(), value)
            })
            .collect(),
    };
    let payload = serde_json::to_vec_pretty(&persisted).map_err(std::io::Error::other)?;
    let temp_path = path.with_extension("tmp");
    std::fs::write(&temp_path, payload)?;
    std::fs::rename(temp_path, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{IdAllocator, IdKind};

    fn unique_path(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lucida_id_allocator_{prefix}_{}_{}",
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn allocate_is_monotonic_per_kind() {
        let mut allocator = IdAllocator::new();

        let first = allocator.allocate(IdKind::Session);
        let second = allocator.allocate(IdKind::Session);

        assert_eq!(first, "sess_00000001");
        assert_eq!(second, "sess_00000002");
    }

    #[test]
    fn allocate_uses_independent_counters_per_kind() {
        let mut allocator = IdAllocator::new();

        let session = allocator.allocate(IdKind::Session);
        let client = allocator.allocate(IdKind::Client);
        let next_session = allocator.allocate(IdKind::Session);

        assert_eq!(session, "sess_00000001");
        assert_eq!(client, "cli_00000001");
        assert_eq!(next_session, "sess_00000002");
    }

    #[test]
    fn allocate_covers_expected_prefixes_for_all_kinds() {
        let mut allocator = IdAllocator::new();

        assert!(allocator.allocate(IdKind::Session).starts_with("sess_"));
        assert!(allocator.allocate(IdKind::Client).starts_with("cli_"));
        assert!(allocator.allocate(IdKind::Scene).starts_with("scn_"));
        assert!(allocator.allocate(IdKind::Source).starts_with("src_"));
        assert!(allocator.allocate(IdKind::Dataset).starts_with("ds_"));
        assert!(allocator.allocate(IdKind::Layer).starts_with("lay_"));
        assert!(allocator.allocate(IdKind::Target).starts_with("tgt_"));
        assert!(allocator.allocate(IdKind::Generation).starts_with("gen_"));
        assert!(allocator.allocate(IdKind::Recipe).starts_with("rr_"));
        assert!(allocator.allocate(IdKind::PublishBatch).starts_with("pub_"));
        assert!(allocator.allocate(IdKind::Token).starts_with("tok_"));
        assert!(
            allocator
                .allocate(IdKind::ContextPackage)
                .starts_with("lcp_")
        );
    }

    #[test]
    fn persistence_keeps_counters_monotonic_across_allocator_instances() {
        let state_path = unique_path("persistence").with_extension("json");
        let mut first = IdAllocator::with_persistence(state_path.clone());
        assert_eq!(first.allocate(IdKind::Session), "sess_00000001");
        assert_eq!(first.allocate(IdKind::Session), "sess_00000002");
        assert_eq!(first.allocate(IdKind::Source), "src_00000001");

        let mut second = IdAllocator::with_persistence(state_path.clone());
        assert_eq!(second.allocate(IdKind::Session), "sess_00000003");
        assert_eq!(second.allocate(IdKind::Source), "src_00000002");

        std::fs::remove_file(state_path).expect("allocator state cleanup should succeed");
    }
}
