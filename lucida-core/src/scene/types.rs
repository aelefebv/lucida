use serde::{Deserialize, Serialize};

use std::collections::HashMap;

use indexmap::IndexMap;
use lucida_content::{DatasetId, LayoutId, LayoutSpec};

use crate::chunk::ChunkCoord;
use crate::command::DocumentCommand;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BlendMode {
    Alpha,
    Additive,
    Max,
}

impl Default for BlendMode {
    fn default() -> Self {
        BlendMode::Alpha
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RenderMode {
    Translucent,
    MaxIntensity,
}

impl Default for RenderMode {
    fn default() -> Self {
        RenderMode::Translucent
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Colormap {
    Gray,
    Magenta,
    Green,
    Cyan,
    Red,
    Blue,
    Yellow,
    Viridis,
    Inferno,
    Plasma,
    Magma,
    Turbo,
    Hot,
    Cool,
    Jet,
}

impl Default for Colormap {
    fn default() -> Self {
        Colormap::Gray
    }
}

impl Colormap {
    pub fn default_for_channel(index: usize) -> Self {
        const CYCLE: [Colormap; 3] = [Colormap::Magenta, Colormap::Green, Colormap::Cyan];
        CYCLE[index % CYCLE.len()]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelSettings {
    pub visible: bool,
    pub colormap: Colormap,
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
}

impl Default for ChannelSettings {
    fn default() -> Self {
        Self {
            visible: true,
            colormap: Colormap::Gray,
            contrast_min: 0.0,
            contrast_max: 65535.0,
            gamma: 1.0,
        }
    }
}

fn default_channel_blend_mode() -> BlendMode {
    BlendMode::Additive
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatasetDisplaySettings {
    pub visible: bool,
    pub opacity: f32,
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
    pub blend_mode: BlendMode,
    #[serde(default)]
    pub render_mode: RenderMode,
    #[serde(default)]
    pub channel_settings: Vec<ChannelSettings>,
    #[serde(default = "default_channel_blend_mode")]
    pub channel_blend_mode: BlendMode,
}

impl DatasetDisplaySettings {
    /// Get a mutable reference to channel settings at the given index,
    /// growing the vec with defaults if needed.
    pub fn ensure_channel(&mut self, index: usize) -> &mut ChannelSettings {
        while self.channel_settings.len() <= index {
            let i = self.channel_settings.len();
            self.channel_settings.push(ChannelSettings {
                colormap: Colormap::default_for_channel(i),
                ..Default::default()
            });
        }
        &mut self.channel_settings[index]
    }
}

impl Default for DatasetDisplaySettings {
    fn default() -> Self {
        Self {
            visible: true,
            opacity: 1.0,
            contrast_min: 0.0,
            contrast_max: 65535.0,
            gamma: 1.0,
            blend_mode: BlendMode::Alpha,
            render_mode: RenderMode::Translucent,
            channel_settings: Vec::new(),
            channel_blend_mode: BlendMode::Additive,
        }
    }
}

/// Display settings (contrast window + gamma).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayState {
    pub contrast_min: f64,
    pub contrast_max: f64,
    pub gamma: f64,
}

impl Default for DisplayState {
    fn default() -> Self {
        Self {
            contrast_min: 0.0,
            contrast_max: 65535.0,
            gamma: 1.0,
        }
    }
}

/// Shared document state — content graphs synced across all clients.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DocumentState {
    pub content_graphs: IndexMap<DatasetId, lucida_content::ContentGraph>,
    #[serde(default)]
    pub registered_layouts: HashMap<DatasetId, Vec<LayoutSpec>>,
    #[serde(default)]
    pub active_layout_ids: HashMap<DatasetId, LayoutId>,
}

impl DocumentState {
    /// Register (or replace) a content graph by dataset id.
    pub fn register_dataset(&mut self, content: lucida_content::ContentGraph) {
        self.content_graphs.insert(content.dataset_id.clone(), content);
    }

    /// Remove a dataset by id.
    pub fn remove_dataset(&mut self, id: &DatasetId) {
        self.content_graphs.shift_remove(id);
    }

    /// Apply a document command directly. Used by the server to avoid
    /// constructing a full Scene for document mutations.
    pub fn apply(&mut self, cmd: DocumentCommand) {
        match cmd {
            DocumentCommand::RegisterDataset(reg) => {
                self.register_dataset(reg.content);
            }
            DocumentCommand::RemoveDataset { id } => {
                self.remove_dataset(&id);
            }
            DocumentCommand::RegisterLayout { dataset_id, layout } => {
                self.registered_layouts
                    .entry(dataset_id)
                    .or_default()
                    .push(layout);
            }
            DocumentCommand::SetActiveLayout { dataset_id, layout_id } => {
                self.active_layout_ids.insert(dataset_id, layout_id);
            }
        }
    }
}

/// Per-member output of chunk planning.
#[derive(Debug, Clone, Serialize)]
pub struct MemberChunkPlan {
    pub image_id: lucida_content::ImageId,
    pub position: [f64; 2],
    pub needed: Vec<ChunkCoord>,
    pub prefetch: Vec<ChunkCoord>,
}
