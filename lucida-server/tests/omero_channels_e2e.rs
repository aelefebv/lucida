//! Frozen acceptance (slice B1): omero channel labels flow into the manifest.
//!
//! Robust to internal accessor names: we serialize the manifest and assert the
//! labels appear under `channel_infos`. Public API only (import_dataset).
use std::fs;
use std::path::PathBuf;

use lucida_store::import::import_dataset;

fn write_store(name: &str, omero: Option<serde_json::Value>) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("slipway-b1-{name}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let mut ome = serde_json::json!({
        "version": "0.5",
        "multiscales": [{
            "version": "0.5",
            "name": "img",
            "axes": [
                {"name": "t", "type": "time"},
                {"name": "c", "type": "channel"},
                {"name": "z", "type": "space"},
                {"name": "y", "type": "space"},
                {"name": "x", "type": "space"}
            ],
            "datasets": [{
                "path": "0",
                "coordinateTransformations": [{"type": "scale", "scale": [1.0,1.0,1.0,1.0,1.0]}]
            }]
        }]
    });
    if let Some(o) = omero {
        ome.as_object_mut().unwrap().insert("omero".into(), o);
    }
    let root =
        serde_json::json!({"zarr_format": 3, "node_type": "group", "attributes": {"ome": ome}});
    fs::write(
        dir.join("zarr.json"),
        serde_json::to_string_pretty(&root).unwrap(),
    )
    .unwrap();

    let level = dir.join("0");
    fs::create_dir_all(&level).unwrap();
    let arr = serde_json::json!({
        "zarr_format": 3, "node_type": "array",
        "shape": [1, 3, 1, 4, 4], "data_type": "uint16",
        "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [1, 3, 1, 4, 4]}},
        "chunk_key_encoding": {"name": "default"},
        "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
        "fill_value": 0
    });
    fs::write(
        level.join("zarr.json"),
        serde_json::to_string_pretty(&arr).unwrap(),
    )
    .unwrap();
    dir
}

fn omero_three() -> serde_json::Value {
    serde_json::json!({"version": "0.5", "channels": [
        {"label": "Channel 0", "color": "0099ff"},
        {"label": "Channel 6", "color": "ff0000"},
        {"label": "Channel 7", "color": "00ff00"}
    ]})
}

#[tokio::test]
async fn omero_labels_flow_into_manifest() {
    let dir = write_store("with-omero", Some(omero_three()));
    let store = lucida_store::backend::open(dir.to_str().unwrap()).unwrap();
    let result = import_dataset(&store, "b1-omero", "B1 omero")
        .await
        .unwrap();
    let json = serde_json::to_value(&result.manifest).unwrap();
    let blob = serde_json::to_string(&json).unwrap();
    assert!(
        blob.contains("channel_infos"),
        "manifest must carry channel_infos: {blob}"
    );
    for label in ["Channel 0", "Channel 6", "Channel 7"] {
        assert!(blob.contains(label), "manifest missing label {label:?}");
    }
}

#[tokio::test]
async fn no_omero_is_back_compatible() {
    let dir = write_store("no-omero", None);
    let store = lucida_store::backend::open(dir.to_str().unwrap()).unwrap();
    let result = import_dataset(&store, "b1-plain", "B1 plain")
        .await
        .unwrap();
    // skip_serializing_if = empty => the field simply doesn't appear; import must not error.
    let blob = serde_json::to_string(&serde_json::to_value(&result.manifest).unwrap()).unwrap();
    assert!(
        !blob.contains("Channel 0"),
        "no-omero store should carry no channel labels"
    );
}
