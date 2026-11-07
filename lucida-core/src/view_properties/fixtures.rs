//! The datasets every view producer is checked against.

use lucida_content::*;
use lucida_protocol::*;

/// One dataset the properties run over, as the server announces it on open.
#[derive(Debug, Clone)]
pub struct Fixture {
    pub name: &'static str,
    pub opened: DatasetOpened,
}

impl Fixture {
    /// Every fixture: a 2D image, a 3D volume, a collection, and a pyramid
    /// whose coarse levels declare chunks larger than themselves.
    pub fn all() -> Vec<Fixture> {
        vec![
            Self::image(),
            Self::volume(),
            Self::collection(),
            Self::pyramid(),
        ]
    }

    /// A flat 2D image, wider than tall, two channels.
    pub fn image() -> Fixture {
        Fixture {
            name: "image",
            opened: single("image", [1, 2, 1, 1536, 2048], [1, 1, 1, 512, 512], 3),
        }
    }

    /// A 3D volume with two timepoints and three channels.
    pub fn volume() -> Fixture {
        Fixture {
            name: "volume",
            opened: single("volume", [2, 3, 128, 512, 512], [1, 1, 64, 128, 128], 3),
        }
    }

    /// Twelve 2D tiles laid out four across and three down, with gaps.
    pub fn collection() -> Fixture {
        Fixture {
            name: "collection",
            opened: collection("collection", 4, 3, [1, 2, 1, 256, 256], 288.0),
        }
    }

    /// A tall volume whose every level keeps the level-0 chunk shape, so from
    /// level 2 down each level is smaller than one declared chunk.
    pub fn pyramid() -> Fixture {
        Fixture {
            name: "pyramid",
            opened: single("pyramid", [1, 1, 64, 2048, 1024], [1, 1, 32, 512, 512], 7),
        }
    }

    pub fn id(&self) -> DatasetId {
        self.opened.manifest.dataset_id.clone()
    }

    /// `[T, C, Z, Y, X]` of the first image at level 0, the shape the CLI and
    /// the web hand to guided exploration.
    pub fn dims(&self) -> [u64; 5] {
        self.opened.manifest.images()[0].multiscale.levels[0].shape
    }

    /// How many images the dataset holds; more than one is a collection.
    pub fn image_count(&self) -> usize {
        self.opened.manifest.images().len()
    }
}

/// `count` levels from `shape`, each halving Z, Y and X (never below one
/// sample) and doubling the sample spacing, all declaring `chunk_shape`.
fn levels(shape: [u64; 5], chunk_shape: [u64; 5], count: u32) -> Vec<LevelGeometry> {
    (0..count)
        .map(|level| {
            let factor = 1u64 << level;
            let shape = [
                shape[0],
                shape[1],
                shape[2].div_ceil(factor),
                shape[3].div_ceil(factor),
                shape[4].div_ceil(factor),
            ];
            let spacing = factor as f64;
            LevelGeometry {
                level_index: level,
                shape,
                chunk_shape,
                grid_shape: std::array::from_fn(|d| shape[d].div_ceil(chunk_shape[d])),
                scale: [1.0, 1.0, spacing, spacing, spacing],
            }
        })
        .collect()
}

fn image_spec(image_id: ImageId, owner: EntityId, levels: Vec<LevelGeometry>) -> ImageSpec {
    let axis = |name: &str, kind| Axis {
        name: name.to_string(),
        kind,
    };
    ImageSpec {
        image_id,
        owner,
        multiscale: MultiscaleInfo {
            axes: vec![
                axis("t", AxisKind::Time),
                axis("c", AxisKind::Channel),
                axis("z", AxisKind::Space),
                axis("y", AxisKind::Space),
                axis("x", AxisKind::Space),
            ],
            levels,
            coarse_level_index: None,
            generated_levels: vec![],
            data_type: DataType::Uint16,
            pinned_axes: vec![],
            downsampling_method: None,
            channel_infos: vec![],
        },
    }
}

fn entity(id: EntityId) -> Entity {
    Entity {
        labels: EntityLabels {
            name: Some(id.0.clone()),
            ..Default::default()
        },
        id,
        kind: EntityKind::Image,
        parent: None,
    }
}

fn opened(manifest: DatasetManifest) -> DatasetOpened {
    let images = manifest
        .images()
        .iter()
        .map(|image| ProxiedImageSpec {
            image_id: image.image_id.clone(),
            wire_format: WireFormat::Raw {
                data_type: DataType::Uint16,
            },
        })
        .collect();
    DatasetOpened {
        manifest,
        fetch: FetchSource::Proxied(ProxiedFetchDescriptor { images }),
        catalog: AssetCatalog::default(),
        opener_client_id: None,
    }
}

fn single(id: &str, shape: [u64; 5], chunk_shape: [u64; 5], level_count: u32) -> DatasetOpened {
    let entity_id = EntityId(format!("{id}-entity"));
    let image = image_spec(
        ImageId(format!("{id}-image")),
        entity_id.clone(),
        levels(shape, chunk_shape, level_count),
    );
    opened(DatasetManifest::new(
        DatasetId(id.to_string()),
        id.to_string(),
        DatasetKind::Single,
        vec![entity(entity_id)],
        vec![],
        vec![image],
        vec![],
        None,
    ))
}

fn collection(id: &str, cols: usize, rows: usize, tile: [u64; 5], pitch: f64) -> DatasetOpened {
    let mut entities = Vec::new();
    let mut images = Vec::new();
    let mut placements = Vec::new();
    for row in 0..rows {
        for col in 0..cols {
            let entity_id = EntityId(format!("{id}-r{row}c{col}"));
            images.push(image_spec(
                ImageId(format!("{}-image", entity_id.0)),
                entity_id.clone(),
                levels(tile, tile, 2),
            ));
            placements.push(EntityPlacement {
                entity_id: entity_id.clone(),
                position: [col as f64 * pitch, row as f64 * pitch],
            });
            entities.push(entity(entity_id));
        }
    }
    let layout = LayoutSpec {
        id: LayoutId("grid".into()),
        name: "Grid".into(),
        placements,
    };
    opened(DatasetManifest::new(
        DatasetId(id.to_string()),
        id.to_string(),
        DatasetKind::Collection {
            rows: (0..rows)
                .map(|r| ((b'A' + r as u8) as char).to_string())
                .collect(),
            columns: (1..=cols).map(|c| c.to_string()).collect(),
            positioning_mode: PositioningMode::Derived,
            has_explicit_positions: false,
        },
        entities,
        vec![],
        images,
        vec![layout],
        Some(LayoutId("grid".into())),
    ))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::Fixture;

    /// Every fixture as `{ "name", "opened" }`, one per line, so a change to
    /// one fixture is a one-line diff.
    fn as_json() -> String {
        let lines: Vec<String> = Fixture::all()
            .iter()
            .map(|f| serde_json::json!({ "name": f.name, "opened": f.opened }).to_string())
            .collect();
        format!("[\n{}\n]\n", lines.join(",\n"))
    }

    /// The web's property tests read the fixtures from this file, so both
    /// halves of the suite check the same datasets.
    #[test]
    fn the_web_reads_the_same_fixtures() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/view-properties/datasets.json");
        let expected = as_json();
        if std::env::var_os("REGEN_VIEW_FIXTURES").is_some_and(|v| !v.is_empty() && v != "0") {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &expected).unwrap();
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            committed == expected,
            "{} is out of date; regenerate it with \
             REGEN_VIEW_FIXTURES=1 cargo test -p lucida-core the_web_reads_the_same_fixtures",
            path.display()
        );
    }
}
