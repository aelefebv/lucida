use std::env;

#[tokio::main]
async fn main() {
    let path = env::args().nth(1).unwrap_or_else(|| {
        eprintln!("Usage: cargo run -p lucida-store --example import_debug -- <path-or-url>");
        eprintln!();
        eprintln!("Examples:");
        eprintln!("  cargo run -p lucida-store --example import_debug -- example_files/yeast_3d_mitochondria.ome.zarr");
        eprintln!("  cargo run -p lucida-store --example import_debug -- gs://bucket/dataset.ome.zarr");
        std::process::exit(1);
    });

    let id = format!("debug-{:x}", {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        path.hash(&mut h);
        h.finish()
    });

    let name = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(&path)
        .to_string();

    // backend::open needs absolute paths for local files
    let path = if !path.starts_with('/') && !path.contains("://") {
        let abs = std::path::Path::new(&path)
            .canonicalize()
            .unwrap_or_else(|e| {
                eprintln!("Cannot resolve path: {e}");
                std::process::exit(1);
            });
        abs.to_string_lossy().to_string()
    } else {
        path
    };

    eprintln!("Opening: {path}");
    let store = match lucida_store::backend::open(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Failed to open store: {e}");
            std::process::exit(1);
        }
    };

    eprintln!("Importing as id={id}, name={name}");
    match lucida_store::import::import_dataset(&store, &id, &name).await {
        Ok(result) => {
            // Summary to stderr
            let n_entities = result.manifest.entities().len();
            let n_images = result.manifest.images().len();
            let n_transforms = result.manifest.transforms().len();
            let n_layouts = result.manifest.source_layouts().len();
            eprintln!();
            eprintln!("=== Import Summary ===");
            eprintln!(
                "  Dataset:    {} ({})",
                result.manifest.name, result.manifest.dataset_id.0
            );
            eprintln!("  Kind:       {:?}", result.manifest.kind);
            eprintln!("  Entities:   {n_entities}");
            eprintln!("  Images:     {n_images}");
            eprintln!("  Transforms: {n_transforms}");
            eprintln!("  Layouts:    {n_layouts}");

            if let Some(img) = result.manifest.images().first() {
                let ms = &img.multiscale;
                eprintln!("  Levels:     {}", ms.levels.len());
                eprintln!("  Data type:  {:?}", ms.data_type);
                if let Some(l0) = ms.levels.first() {
                    eprintln!(
                        "  Level 0:    shape={:?}  chunk={:?}  grid={:?}",
                        l0.shape, l0.chunk_shape, l0.grid_shape
                    );
                }
                eprintln!(
                    "  Axes:       {:?}",
                    ms.axes.iter().map(|a| &a.name).collect::<Vec<_>>()
                );
            }

            eprintln!(
                "  Fetch mode: {}",
                match &result.fetch {
                    lucida_protocol::FetchSource::Proxied(p) =>
                        format!("Proxied ({} images)", p.images.len()),
                    lucida_protocol::FetchSource::Direct(d) =>
                        format!("Direct ({} images)", d.images.len()),
                    lucida_protocol::FetchSource::Local(l) =>
                        format!("Local ({} images)", l.images.len()),
                }
            );
            eprintln!(
                "  Binding:    {} image seeds",
                result.binding_seed.images.len()
            );
            eprintln!();

            // Full JSON to stdout (pipe to file or jq)
            println!("{}", serde_json::to_string_pretty(&result).unwrap());
        }
        Err(e) => {
            eprintln!("Import failed: {e}");
            std::process::exit(1);
        }
    }
}
