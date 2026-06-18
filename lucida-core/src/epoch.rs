use serde::{Deserialize, Serialize};

/// Typed epoch counters for Scene State invalidation.
///
/// Each epoch is a monotonically increasing u64 that bumps when the
/// corresponding category of state changes. Consumers compare epoch
/// values to decide whether to reprocess.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SceneEpochs {
    /// Entity membership or metadata changed (DatasetOpened, RemoveDataset)
    pub content: u64,
    /// Spatial layout changed (RegisterLayout, SetActiveLayout)
    pub layout: u64,
    /// Camera moved (Pan, Zoom, Rotate, Fly, SetCenter, SetViewport, mode switch)
    pub view: u64,
    /// Selection-like state changed (SetT, SetC, SetZ, SetMultiChannel,
    /// channel visibility/settings, render mode, contrast, gamma)
    pub selection: u64,
    /// Asset catalog changed (proxy availability published or revoked).
    /// Bumped by `DocumentCommand::ApplyAssetCatalogDelta`.
    #[serde(default)]
    pub asset: u64,
    /// Collaborative annotations changed (a pin added, removed, or moved; a
    /// comment added, removed, or edited).
    /// Bumped by `DocumentCommand::AddAnnotation` / `RemoveAnnotation` /
    /// `MoveAnnotation` / `AddComment` / `RemoveComment` / `EditComment`.
    #[serde(default)]
    pub annotation: u64,
}
