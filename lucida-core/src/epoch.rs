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
    /// Selection-like state changed (SetT, SetZ, channel solo,
    /// channel visibility/settings, render mode, contrast, gamma, and the
    /// layers a comparison sets aside)
    pub selection: u64,
    /// Collaborative annotations changed (a pin added, removed, or moved; a
    /// comment added, removed, or edited).
    /// Bumped by `DocumentCommand::AddAnnotation` / `RemoveAnnotation` /
    /// `MoveAnnotation` / `AddComment` / `RemoveComment` / `EditComment`.
    #[serde(default)]
    pub annotation: u64,
    /// The comparison the view shows changed. Planning reads it nowhere,
    /// since a divider, a mode or a blink changes only where each of the
    /// pair is drawn. Setting other layers aside, or bringing them back,
    /// moves `selection` as well.
    #[serde(default)]
    pub comparison: u64,
    /// How the views link changed: a property's mode, or the defaults a new
    /// pair of datasets takes. Planning reads it nowhere; a link that moves
    /// a view moves `view` or `selection` as well.
    #[serde(default)]
    pub links: u64,
}
