pub mod auth_principal;
pub mod camera;
pub mod chunk;
pub mod chunk_codec;
pub mod command;
pub mod cursor;
pub mod epoch;
pub mod framing;
pub(crate) mod gzip;
pub(crate) mod mat4;
pub mod minimap;
pub mod protocol;
pub mod query;
pub mod ray;
pub mod saved_view;
pub mod scene;
pub mod target_level;
pub mod transform;
pub mod view;
#[cfg(any(test, feature = "test-support"))]
pub mod view_properties;
pub mod view_transform;
pub mod viewer_profile;
pub mod wasm_log;

pub use epoch::SceneEpochs;
pub use lucida_content::{DatasetId, DatasetManifest, EntityId, ImageId};
pub use lucida_protocol::DatasetOpened;
pub use query::{EntityQueryResult, ViewQueryResult};
pub use ray::{Ray, RayHit};

#[cfg(target_arch = "wasm32")]
mod wasm;
