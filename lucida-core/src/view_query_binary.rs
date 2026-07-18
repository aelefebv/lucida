//! Compact, versioned wire encoding for scene view queries.
//!
//! The web planner used to pay for `serde_json::to_string` in WASM and then
//! `JSON.parse` in JavaScript for full sets and incremental deltas. This module
//! keeps the same set/delta semantics and ordering, but writes directly into
//! one pre-sized byte buffer that wasm-bindgen exposes as a `Uint8Array`.
//!
//! # Version 1 layout (all integers/floats little-endian)
//!
//! ```text
//! full/unknown header (56 bytes)
//!   0   [u8; 4]  magic = "LVQ1"
//!   4   u16      version = 1
//!   6   u16      flags (bit 0 = dataset present; all others reserved)
//!   8   u32      record count
//!   12  u32      header byte length = 56
//!   16  u64[5]   content/layout/view/selection/annotation epochs
//!
//! repeated record (64-byte scalar prefix + UTF-8 ids)
//!   0   u32      entity-id byte length
//!   4   u32      image-id byte length
//!   8   u32      ideal target LOD
//!   12  u8       kind (0 Image, 1 Group, 2 Tile)
//!   13  u8       visible (0/1)
//!   14  u16      reserved = 0
//!   16  f64[6]   projected diagonal, projected area, centroid xyz, importance
//!   64  u8[...]  entity-id bytes, immediately followed by image-id bytes
//!
//! delta header (64 bytes)
//!   0   [u8; 4]  magic = "LVD1"
//!   4   u16      version = 1
//!   6   u16      flags (bit 0 = dataset present; all others reserved)
//!   8   u32      entered record count
//!   12  u32      left image-id count
//!   16  u32      changed record count
//!   20  u32      header byte length = 64
//!   24  u64[5]   content/layout/view/selection/annotation epochs
//!   64  records  entered records using the common record layout
//!   ... ids      each left id as `u32 byte_length + UTF-8 bytes`
//!   ... records  changed records using the common record layout
//! ```
//!
//! A `ViewQueryDelta::Full` uses the full `LVQ1` frame directly. An unknown
//! dataset is a valid `LVD1` header with the presence bit clear and no entries;
//! it remains distinct from a known empty full set.

use std::fmt;

use lucida_content::{EntityKind, ImageId};

use crate::epoch::SceneEpochs;
use crate::query::{EntityQueryResult, ViewQueryDelta, ViewQueryResult};

pub(crate) const FULL_MAGIC: [u8; 4] = *b"LVQ1";
pub(crate) const DELTA_MAGIC: [u8; 4] = *b"LVD1";
pub(crate) const VERSION: u16 = 1;
pub(crate) const FULL_HEADER_BYTES: usize = 56;
pub(crate) const DELTA_HEADER_BYTES: usize = 64;
pub(crate) const RECORD_PREFIX_BYTES: usize = 64;
const LEFT_ID_PREFIX_BYTES: usize = 4;
const FLAG_PRESENT: u16 = 1;

/// The only fallible cases are representational limits or address-space
/// overflow. They are surfaced to JavaScript instead of being conflated with
/// an unknown dataset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EncodeError(&'static str);

impl fmt::Display for EncodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "view-query binary encode failed: {}", self.0)
    }
}

impl std::error::Error for EncodeError {}

fn u32_len(value: usize, what: &'static str) -> Result<u32, EncodeError> {
    u32::try_from(value).map_err(|_| EncodeError(what))
}

fn add_len(total: &mut usize, amount: usize) -> Result<(), EncodeError> {
    *total = total
        .checked_add(amount)
        .ok_or(EncodeError("encoded byte length overflowed usize"))?;
    Ok(())
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_f64(out: &mut Vec<u8>, value: f64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_epochs(out: &mut Vec<u8>, epochs: &SceneEpochs) {
    for epoch in [
        epochs.content,
        epochs.layout,
        epochs.view,
        epochs.selection,
        epochs.annotation,
    ] {
        push_u64(out, epoch);
    }
}

fn record_len(row: &EntityQueryResult) -> Result<usize, EncodeError> {
    let entity_bytes = row.entity_id.0.as_bytes();
    let image_bytes = row.image_id.0.as_bytes();
    u32_len(entity_bytes.len(), "entity id exceeds the u32 wire limit")?;
    u32_len(image_bytes.len(), "image id exceeds the u32 wire limit")?;
    for value in [
        row.projected_diagonal_px,
        row.projected_area_px2,
        row.centroid_world[0],
        row.centroid_world[1],
        row.centroid_world[2],
        row.importance,
    ] {
        if !value.is_finite() {
            return Err(EncodeError("query contains a non-finite scalar"));
        }
    }
    RECORD_PREFIX_BYTES
        .checked_add(entity_bytes.len())
        .and_then(|len| len.checked_add(image_bytes.len()))
        .ok_or(EncodeError("encoded record length overflowed usize"))
}

fn add_records_len(total: &mut usize, rows: &[EntityQueryResult]) -> Result<(), EncodeError> {
    for row in rows {
        add_len(total, record_len(row)?)?;
    }
    Ok(())
}

fn push_record(out: &mut Vec<u8>, row: &EntityQueryResult) {
    let entity_bytes = row.entity_id.0.as_bytes();
    let image_bytes = row.image_id.0.as_bytes();
    push_u32(
        out,
        u32::try_from(entity_bytes.len()).expect("validated entity-id length"),
    );
    push_u32(
        out,
        u32::try_from(image_bytes.len()).expect("validated image-id length"),
    );
    push_u32(out, row.ideal_target_lod);
    out.push(match row.kind {
        EntityKind::Image => 0,
        EntityKind::Group => 1,
        EntityKind::Tile => 2,
    });
    out.push(u8::from(row.visible));
    push_u16(out, 0);
    for value in [
        row.projected_diagonal_px,
        row.projected_area_px2,
        row.centroid_world[0],
        row.centroid_world[1],
        row.centroid_world[2],
        row.importance,
    ] {
        debug_assert!(value.is_finite());
        push_f64(out, value);
    }
    out.extend_from_slice(entity_bytes);
    out.extend_from_slice(image_bytes);
}

fn left_id_len(id: &ImageId) -> Result<usize, EncodeError> {
    let bytes = id.0.as_bytes();
    u32_len(bytes.len(), "left image id exceeds the u32 wire limit")?;
    LEFT_ID_PREFIX_BYTES
        .checked_add(bytes.len())
        .ok_or(EncodeError("encoded left-id length overflowed usize"))
}

fn push_left_id(out: &mut Vec<u8>, id: &ImageId) {
    let bytes = id.0.as_bytes();
    push_u32(
        out,
        u32::try_from(bytes.len()).expect("validated left image-id length"),
    );
    out.extend_from_slice(bytes);
}

/// Encode an authoritative full view query. The output preserves the source
/// vector's order exactly; callers that treat it as a set retain the same
/// membership and per-record values as the JSON representation.
pub(crate) fn encode(result: Option<&ViewQueryResult>) -> Result<Vec<u8>, EncodeError> {
    let record_count = match result {
        Some(result) => u32_len(
            result.visible_entities.len(),
            "record count exceeds the u32 wire limit",
        )?,
        None => 0,
    };

    // Size once, allocate once, then write without intermediate JSON strings
    // or per-record byte buffers.
    let mut encoded_len = FULL_HEADER_BYTES;
    if let Some(result) = result {
        add_records_len(&mut encoded_len, &result.visible_entities)?;
    }

    let mut out = Vec::with_capacity(encoded_len);
    out.extend_from_slice(&FULL_MAGIC);
    push_u16(&mut out, VERSION);
    push_u16(&mut out, if result.is_some() { FLAG_PRESENT } else { 0 });
    push_u32(&mut out, record_count);
    push_u32(
        &mut out,
        u32::try_from(FULL_HEADER_BYTES).expect("version-1 full header length fits u32"),
    );

    if let Some(result) = result {
        push_epochs(&mut out, &result.epochs);
        for row in &result.visible_entities {
            push_record(&mut out, row);
        }
    } else {
        out.resize(FULL_HEADER_BYTES, 0);
    }

    debug_assert_eq!(out.len(), encoded_len);
    Ok(out)
}

/// Encode an incremental query. `Full` reuses the full frame verbatim so
/// producer and consumer have only one authoritative full-set representation.
pub(crate) fn encode_delta(delta: Option<&ViewQueryDelta>) -> Result<Vec<u8>, EncodeError> {
    if let Some(ViewQueryDelta::Full(result)) = delta {
        return encode(Some(result));
    }

    let (epochs, entered, left, changed) = match delta {
        Some(ViewQueryDelta::Delta {
            epochs,
            entered,
            left,
            changed,
        }) => (
            Some(epochs),
            entered.as_slice(),
            left.as_slice(),
            changed.as_slice(),
        ),
        None => (None, &[][..], &[][..], &[][..]),
        Some(ViewQueryDelta::Full(_)) => unreachable!("full returned above"),
    };
    let entered_count = u32_len(entered.len(), "entered count exceeds the u32 wire limit")?;
    let left_count = u32_len(left.len(), "left count exceeds the u32 wire limit")?;
    let changed_count = u32_len(changed.len(), "changed count exceeds the u32 wire limit")?;

    let mut encoded_len = DELTA_HEADER_BYTES;
    add_records_len(&mut encoded_len, entered)?;
    for id in left {
        add_len(&mut encoded_len, left_id_len(id)?)?;
    }
    add_records_len(&mut encoded_len, changed)?;

    let mut out = Vec::with_capacity(encoded_len);
    out.extend_from_slice(&DELTA_MAGIC);
    push_u16(&mut out, VERSION);
    push_u16(&mut out, if epochs.is_some() { FLAG_PRESENT } else { 0 });
    push_u32(&mut out, entered_count);
    push_u32(&mut out, left_count);
    push_u32(&mut out, changed_count);
    push_u32(
        &mut out,
        u32::try_from(DELTA_HEADER_BYTES).expect("version-1 delta header length fits u32"),
    );
    if let Some(epochs) = epochs {
        push_epochs(&mut out, epochs);
        for row in entered {
            push_record(&mut out, row);
        }
        for id in left {
            push_left_id(&mut out, id);
        }
        for row in changed {
            push_record(&mut out, row);
        }
    } else {
        out.resize(DELTA_HEADER_BYTES, 0);
    }

    debug_assert_eq!(out.len(), encoded_len);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epoch::SceneEpochs;
    use crate::query::EntityQueryResult;
    use lucida_content::{EntityId, ImageId};

    #[derive(serde::Deserialize)]
    struct GoldenFixture {
        format_version: u16,
        frame_hex: String,
        value: ViewQueryResult,
    }

    #[derive(serde::Deserialize)]
    struct DeltaGoldenFixture {
        format_version: u16,
        frame_hex: String,
        value: ViewQueryDelta,
    }

    fn to_hex(bytes: &[u8]) -> String {
        use std::fmt::Write as _;
        let mut hex = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            write!(&mut hex, "{byte:02x}").unwrap();
        }
        hex
    }

    fn row(index: usize, kind: EntityKind) -> EntityQueryResult {
        EntityQueryResult {
            entity_id: EntityId(format!("entity-{index:04}")),
            image_id: ImageId(format!("image-{index:04}")),
            kind,
            visible: index.is_multiple_of(2),
            projected_diagonal_px: 100.25 + index as f64,
            projected_area_px2: 10_000.5 + index as f64,
            centroid_world: [index as f64, index as f64 + 0.5, index as f64 + 1.0],
            ideal_target_lod: (index % 7) as u32,
            importance: 0.125 + index as f64,
        }
    }

    fn result(rows: usize) -> ViewQueryResult {
        ViewQueryResult {
            epochs: SceneEpochs {
                content: 1,
                layout: 2,
                view: 3,
                selection: 4,
                annotation: 5,
            },
            visible_entities: (0..rows)
                .map(|index| {
                    let kind = match index % 3 {
                        0 => EntityKind::Image,
                        1 => EntityKind::Group,
                        _ => EntityKind::Tile,
                    };
                    row(index, kind)
                })
                .collect(),
        }
    }

    #[test]
    fn unknown_and_known_empty_sets_are_distinct() {
        let unknown = encode(None).unwrap();
        let known = encode(Some(&result(0))).unwrap();
        assert_eq!(unknown.len(), FULL_HEADER_BYTES);
        assert_eq!(known.len(), FULL_HEADER_BYTES);
        assert_eq!(&unknown[..4], b"LVQ1");
        assert_eq!(u16::from_le_bytes(unknown[6..8].try_into().unwrap()), 0);
        assert_eq!(
            u16::from_le_bytes(known[6..8].try_into().unwrap()),
            FLAG_PRESENT
        );
        assert_ne!(unknown, known);
    }

    #[test]
    fn encoding_matches_the_cross_language_golden_byte_for_byte() {
        let fixture: GoldenFixture = serde_json::from_str(include_str!(
            "../../wire-fixtures/binary/view_query_v1.json"
        ))
        .unwrap();
        assert_eq!(fixture.format_version, VERSION);
        let encoded = encode(Some(&fixture.value)).unwrap();
        assert_eq!(to_hex(&encoded), fixture.frame_hex);
    }

    #[test]
    fn delta_encoding_matches_the_cross_language_golden_byte_for_byte() {
        let fixture: DeltaGoldenFixture = serde_json::from_str(include_str!(
            "../../wire-fixtures/binary/view_query_delta_v1.json"
        ))
        .unwrap();
        assert_eq!(fixture.format_version, VERSION);
        let encoded = encode_delta(Some(&fixture.value)).unwrap();
        assert_eq!(to_hex(&encoded), fixture.frame_hex);
    }

    #[test]
    fn delta_unknown_and_full_reuse_the_canonical_sentinels_and_full_frame() {
        let unknown = encode_delta(None).unwrap();
        assert_eq!(unknown.len(), DELTA_HEADER_BYTES);
        assert_eq!(&unknown[..4], b"LVD1");
        assert_eq!(u16::from_le_bytes(unknown[6..8].try_into().unwrap()), 0);

        let query = result(3);
        let full = ViewQueryDelta::Full(query.clone());
        assert_eq!(
            encode_delta(Some(&full)).unwrap(),
            encode(Some(&query)).unwrap()
        );
    }

    #[test]
    fn wide_collection_encoding_is_exactly_sized_and_compact() {
        let query = result(216);
        let binary = encode(Some(&query)).unwrap();
        let expected = FULL_HEADER_BYTES
            + query
                .visible_entities
                .iter()
                .map(|row| RECORD_PREFIX_BYTES + row.entity_id.0.len() + row.image_id.0.len())
                .sum::<usize>();
        assert_eq!(binary.len(), expected);

        let json = serde_json::to_vec(&query).unwrap();
        assert!(
            binary.len() * 2 < json.len(),
            "binary={} JSON={}",
            binary.len(),
            json.len(),
        );
    }

    #[test]
    fn non_finite_geometry_is_an_error_not_an_unknown_dataset_frame() {
        let mut query = result(1);
        query.visible_entities[0].importance = f64::NAN;
        assert_eq!(
            encode(Some(&query)).unwrap_err(),
            EncodeError("query contains a non-finite scalar")
        );
    }

    /// Focused, opt-in evidence for the boundary itself. Run with:
    /// `cargo test -p lucida-core --release view_query_binary_release_profile -- --ignored --nocapture`
    ///
    /// There is deliberately no wall-clock assertion: shared CI runners make
    /// absolute or relative timing gates flaky. The deterministic byte-size
    /// assertion lives in the normal test above; this prints comparable
    /// release timings for the old serializer and the replacement.
    #[test]
    #[ignore = "release-only view-query serializer profile"]
    fn view_query_binary_release_profile() {
        use std::hint::black_box;
        use std::time::Instant;

        const ITERATIONS: usize = 10_000;
        let query = result(216);

        let started = Instant::now();
        let mut binary_bytes = 0;
        for _ in 0..ITERATIONS {
            binary_bytes = black_box(encode(Some(black_box(&query))).unwrap()).len();
        }
        let binary_elapsed = started.elapsed();

        let started = Instant::now();
        let mut json_bytes = 0;
        for _ in 0..ITERATIONS {
            json_bytes = black_box(serde_json::to_vec(black_box(&query)).unwrap()).len();
        }
        let json_elapsed = started.elapsed();

        eprintln!(
            "view_query 216 rows x {ITERATIONS}: binary={binary_elapsed:?} ({binary_bytes} B), JSON={json_elapsed:?} ({json_bytes} B)"
        );
        assert!(binary_bytes * 2 < json_bytes);

        let delta = ViewQueryDelta::Delta {
            epochs: query.epochs.clone(),
            entered: query.visible_entities[0..4].to_vec(),
            left: query.visible_entities[4..8]
                .iter()
                .map(|row| row.image_id.clone())
                .collect(),
            changed: query.visible_entities[8..12].to_vec(),
        };
        let started = Instant::now();
        let mut delta_binary_bytes = 0;
        for _ in 0..ITERATIONS {
            delta_binary_bytes = black_box(encode_delta(Some(black_box(&delta))).unwrap()).len();
        }
        let delta_binary_elapsed = started.elapsed();
        let started = Instant::now();
        let mut delta_json_bytes = 0;
        for _ in 0..ITERATIONS {
            delta_json_bytes = black_box(serde_json::to_vec(black_box(&delta)).unwrap()).len();
        }
        let delta_json_elapsed = started.elapsed();
        eprintln!(
            "view_query_delta 12 changes x {ITERATIONS}: binary={delta_binary_elapsed:?} ({delta_binary_bytes} B), JSON={delta_json_elapsed:?} ({delta_json_bytes} B)"
        );
        assert!(delta_binary_bytes * 2 < delta_json_bytes);
    }
}
