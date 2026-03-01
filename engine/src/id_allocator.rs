use std::collections::BTreeMap;

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
}

#[derive(Debug, Default)]
pub struct IdAllocator {
    counters: BTreeMap<IdKind, u64>,
}

impl IdAllocator {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn allocate(&mut self, kind: IdKind) -> String {
        let counter = self.counters.entry(kind).or_insert(0);
        *counter += 1;
        format!("{}_{:08}", kind.prefix(), counter)
    }
}

#[cfg(test)]
mod tests {
    use super::{IdAllocator, IdKind};

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
}
