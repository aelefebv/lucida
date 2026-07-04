//! Legacy proxy availability catalog: which proxy kinds each manifest
//! entity advertises when the legacy proxy bridge is enabled, plus the
//! shared target-size constant that keeps catalog footprints, on-demand
//! asset serving, and background pre-generation in lockstep.

use lucida_content::{DatasetManifest, EntityId, EntityKind};
use lucida_protocol::{ProxyAvailability, ProxyFootprint};
use lucida_proxy::{ProxyKind, ProxySpec, estimate_proxy_dims};

/// Soft cap on the longest output dimension of a proxy. Mirrors the value
/// used by `serve_asset_request` so the cache key (which is derived from
/// `(entity, kind, t, c)` only, not the target) stays in lockstep with the
/// pre-generation task.
pub(crate) const PROXY_TARGET_LONG_AXIS: u32 = 128;

pub(crate) fn proxy_catalog_entries_for_manifest(
    manifest: &DatasetManifest,
    legacy_proxy_enabled: bool,
) -> Vec<ProxyAvailability> {
    if !legacy_proxy_enabled {
        return vec![];
    }

    // Build the legacy proxy availability catalog by enumerating
    // entities. Wells advertise WellProxy3D, Fields advertise FieldProxy3D,
    // and bare Images advertise FieldProxy3D (the proxy generator falls
    // back to FieldProxy semantics for non-Well entities — see
    // `build_server_proxy_source`). Entities without a contributing image
    // are skipped — Planning has nothing to fetch for them.
    manifest
        .entities()
        .iter()
        .filter_map(|entity| {
            let kinds = match entity.kind {
                EntityKind::Well => vec![ProxyKind::WellProxy3D],
                EntityKind::Field | EntityKind::Image => vec![ProxyKind::FieldProxy3D],
            };
            // Only advertise entities that own an image (Wells aggregate
            // their fields' images downstream, so we keep all Wells).
            let has_image = matches!(entity.kind, EntityKind::Well)
                || manifest.images().iter().any(|img| img.owner == entity.id);
            if !has_image {
                return None;
            }
            let footprints = proxy_footprints_for_entity(manifest, &entity.id, &kinds);
            Some(ProxyAvailability {
                entity_id: entity.id.clone(),
                kinds,
                footprints,
            })
        })
        .collect()
}

fn proxy_footprints_for_entity(
    manifest: &DatasetManifest,
    entity_id: &EntityId,
    kinds: &[ProxyKind],
) -> Vec<ProxyFootprint> {
    kinds
        .iter()
        .filter_map(|kind| {
            let spec = ProxySpec {
                entity_id: entity_id.clone(),
                kind: *kind,
                t: 0,
                c: 0,
                target_long_axis: PROXY_TARGET_LONG_AXIS,
            };
            estimate_proxy_dims(&spec, manifest)
                .ok()
                .map(|dims| ProxyFootprint::u16(*kind, dims))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::single_image_manifest;

    #[test]
    fn proxy_catalog_is_empty_on_default_path() {
        let manifest = single_image_manifest();
        let entries = proxy_catalog_entries_for_manifest(&manifest, false);
        assert!(entries.is_empty());
    }

    #[test]
    fn proxy_catalog_is_available_only_for_legacy_bridge() {
        let manifest = single_image_manifest();
        let entries = proxy_catalog_entries_for_manifest(&manifest, true);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kinds, vec![ProxyKind::FieldProxy3D]);
    }
}
