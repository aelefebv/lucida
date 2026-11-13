//! The one place a server's dataset sources are built.

use std::sync::Arc;

use lucida_store::source_policy::SourcePolicy;

use super::{DatasetSource, ObjectStoreSource};

/// What a source may be built from. A source with settings of its own
/// reads them itself.
pub struct SourceContext {
    pub policy: Arc<SourcePolicy>,
}

/// Every dataset source this server lists from. A build that lists
/// datasets from somewhere else adds its source's `configured(context)` to
/// the list, one entry each; the index and the routes take whatever this
/// returns.
pub async fn configured(context: &SourceContext) -> Vec<Arc<dyn DatasetSource>> {
    let sources = vec![ObjectStoreSource::configured(context).await];
    sources.into_iter().flatten().collect()
}
