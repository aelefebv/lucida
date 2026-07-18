//! Bounded metadata reads for dataset import.
//!
//! Import used to read directly from the raw `ObjectStore`, which bypassed the
//! process source-read semaphore, per-object ceiling, resident-memory budget,
//! and exact-length collection used for chunk bodies. `MetadataReader` gives
//! every import a unique, short-lived cache namespace over those same shared
//! controls. Repeated metadata reads inside one import coalesce, while a later
//! import can never reuse stale metadata from a mutable locator.

use std::fmt;
use std::mem::size_of;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use object_store::ObjectStore;
use object_store::path::Path;
use serde::de::{DeserializeOwned, DeserializeSeed, Error as _, MapAccess, SeqAccess, Visitor};

use crate::backend::StoreError;
use crate::budget::{MemoryCategory, MemoryReservation};
use crate::cache::{CachedBytes, CachedStore, SharedObjectCache};

/// Metadata is structurally small compared with source chunks. A dedicated
/// ceiling limits JSON parse amplification even when operators permit much
/// larger chunk objects.
pub(crate) const DEFAULT_MAX_METADATA_OBJECT_BYTES: usize = 16 * 1024 * 1024;

/// Standalone consumers (Python, examples, and tests) still receive a hard
/// aggregate body budget. The server supplies its process-wide cache instead.
const DEFAULT_STANDALONE_IMPORT_BUDGET_BYTES: usize = 128 * 1024 * 1024;

/// Structural accounting bounds used by the preflight JSON walk.
///
/// A wire-size multiplier cannot bound `serde_json::Value`: `[[0], ...]`
/// expands past 40x because every one-element inner `Vec<Value>` allocates a
/// four-slot buffer. Tiny objects are worse because each `BTreeMap` allocates
/// a node. The walk below therefore charges actual JSON shape before the real
/// deserialization: every value node, string payload, array allocation, and a
/// deliberately overfull object-node allowance per entry. It retains no
/// parsed values itself.
const JSON_ARRAY_MIN_CAPACITY_BOUND: usize = 4;
const JSON_ARRAY_CAPACITY_FACTOR_BOUND: usize = 2;
const JSON_OBJECT_NODE_SLOT_BOUND: usize = 16;
const JSON_ALLOCATION_BOOKKEEPING_BOUND: usize = 4 * size_of::<usize>();

static NEXT_IMPORT_NAMESPACE: AtomicU64 = AtomicU64::new(1);

struct MetadataReaderInner {
    cache: CachedStore,
    shared: Arc<SharedObjectCache>,
    namespace: Arc<str>,
}

impl Drop for MetadataReaderInner {
    fn drop(&mut self) {
        // All futures borrow/clone this inner Arc, so reaching Drop proves no
        // metadata read remains live. Retiring the namespace also guards the
        // cancellation edge where a backend future completes late.
        self.shared.invalidate_namespace(&self.namespace);
    }
}

/// Cloneable import-scoped metadata capability.
#[derive(Clone)]
pub(crate) struct MetadataReader(Arc<MetadataReaderInner>);

/// One parsed JSON value plus its structural process-memory claim.
///
/// There is deliberately no `into_inner`: retained parsed data cannot be
/// detached from the reservation by accident. Typed metadata and general
/// `Value` trees use the same owner.
#[derive(Debug)]
pub(crate) struct ParsedJson<T> {
    value: T,
    _reservation: MemoryReservation,
}

impl<T> std::ops::Deref for ParsedJson<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.value
    }
}

impl<T> AsRef<T> for ParsedJson<T> {
    fn as_ref(&self) -> &T {
        &self.value
    }
}

pub(crate) type ParsedJsonValue = ParsedJson<serde_json::Value>;

#[derive(Default)]
struct JsonRetainedEstimate {
    bytes: usize,
}

impl JsonRetainedEstimate {
    fn add(&mut self, bytes: usize) -> Result<(), &'static str> {
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or("parsed JSON structural estimate overflowed")?;
        Ok(())
    }

    fn add_value_node(&mut self) -> Result<(), &'static str> {
        self.add(size_of::<serde_json::Value>())
    }

    fn add_string_payload(&mut self, bytes: usize) -> Result<(), &'static str> {
        // serde_json grows owned String buffers geometrically. Twice the
        // decoded length bounds the retained capacity for this build; the
        // separate workspace reservation covers the decoder scratch buffer.
        self.add(
            bytes
                .checked_mul(2)
                .ok_or("parsed JSON string capacity estimate overflowed")?,
        )?;
        self.add(JSON_ALLOCATION_BOOKKEEPING_BOUND)
    }

    fn add_array_storage(&mut self, len: usize) -> Result<(), &'static str> {
        if len == 0 {
            return Ok(());
        }
        let slots = len
            .checked_mul(JSON_ARRAY_CAPACITY_FACTOR_BOUND)
            .ok_or("parsed JSON array capacity estimate overflowed")?
            .max(JSON_ARRAY_MIN_CAPACITY_BOUND);
        self.add(
            slots
                .checked_mul(size_of::<serde_json::Value>())
                .ok_or("parsed JSON array storage estimate overflowed")?,
        )?;
        self.add(JSON_ALLOCATION_BOOKKEEPING_BOUND)
    }

    fn add_object_entry(&mut self, key_bytes: usize) -> Result<(), &'static str> {
        // serde_json's default Map is a BTreeMap. Charge one complete
        // 16-slot node plus edge pointers for *every* entry. This exceeds the
        // current standard-library node capacity and intentionally
        // double-counts the child Value node, making tiny one-entry maps (the
        // adverse case) safe without depending on average tree occupancy.
        let slot_bytes = size_of::<String>()
            .checked_add(size_of::<serde_json::Value>())
            .ok_or("parsed JSON object slot estimate overflowed")?;
        self.add(
            JSON_OBJECT_NODE_SLOT_BOUND
                .checked_mul(slot_bytes)
                .ok_or("parsed JSON object node estimate overflowed")?,
        )?;
        self.add(
            (JSON_OBJECT_NODE_SLOT_BOUND + 1)
                .checked_mul(size_of::<usize>())
                .ok_or("parsed JSON object edge estimate overflowed")?,
        )?;
        self.add(JSON_ALLOCATION_BOOKKEEPING_BOUND)?;
        self.add_string_payload(key_bytes)
    }
}

struct JsonEstimateSeed<'a> {
    estimate: &'a mut JsonRetainedEstimate,
}

struct JsonKeyLengthSeed;

impl<'de> DeserializeSeed<'de> for JsonKeyLengthSeed {
    type Value = usize;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_str(JsonKeyLengthVisitor)
    }
}

struct JsonKeyLengthVisitor;

impl<'de> Visitor<'de> for JsonKeyLengthVisitor {
    type Value = usize;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON object key")
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<usize, E> {
        Ok(value.len())
    }

    fn visit_borrowed_str<E: serde::de::Error>(self, value: &'de str) -> Result<usize, E> {
        Ok(value.len())
    }

    fn visit_string<E: serde::de::Error>(self, value: String) -> Result<usize, E> {
        Ok(value.len())
    }
}

impl<'de> DeserializeSeed<'de> for JsonEstimateSeed<'_> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(JsonEstimateVisitor {
            estimate: self.estimate,
        })
    }
}

struct JsonEstimateVisitor<'a> {
    estimate: &'a mut JsonRetainedEstimate,
}

impl JsonEstimateVisitor<'_> {
    fn scalar<E: serde::de::Error>(&mut self) -> Result<(), E> {
        self.estimate.add_value_node().map_err(E::custom)
    }

    fn string<E: serde::de::Error>(&mut self, value: &str) -> Result<(), E> {
        self.scalar()?;
        self.estimate
            .add_string_payload(value.len())
            .map_err(E::custom)
    }
}

impl<'de> Visitor<'de> for JsonEstimateVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E: serde::de::Error>(mut self, _value: bool) -> Result<(), E> {
        self.scalar()
    }

    fn visit_i64<E: serde::de::Error>(mut self, _value: i64) -> Result<(), E> {
        self.scalar()
    }

    fn visit_i128<E: serde::de::Error>(mut self, _value: i128) -> Result<(), E> {
        self.scalar()
    }

    fn visit_u64<E: serde::de::Error>(mut self, _value: u64) -> Result<(), E> {
        self.scalar()
    }

    fn visit_u128<E: serde::de::Error>(mut self, _value: u128) -> Result<(), E> {
        self.scalar()
    }

    fn visit_f64<E: serde::de::Error>(mut self, _value: f64) -> Result<(), E> {
        self.scalar()
    }

    fn visit_str<E: serde::de::Error>(mut self, value: &str) -> Result<(), E> {
        self.string(value)
    }

    fn visit_borrowed_str<E: serde::de::Error>(mut self, value: &'de str) -> Result<(), E> {
        self.string(value)
    }

    fn visit_string<E: serde::de::Error>(mut self, value: String) -> Result<(), E> {
        self.string(&value)
    }

    fn visit_none<E: serde::de::Error>(mut self) -> Result<(), E> {
        self.scalar()
    }

    fn visit_unit<E: serde::de::Error>(mut self) -> Result<(), E> {
        self.scalar()
    }

    fn visit_seq<A>(mut self, mut sequence: A) -> Result<(), A::Error>
    where
        A: SeqAccess<'de>,
    {
        self.scalar()?;
        let mut len = 0usize;
        while sequence
            .next_element_seed(JsonEstimateSeed {
                estimate: self.estimate,
            })?
            .is_some()
        {
            len = len
                .checked_add(1)
                .ok_or_else(|| A::Error::custom("parsed JSON array length overflowed"))?;
        }
        self.estimate
            .add_array_storage(len)
            .map_err(A::Error::custom)
    }

    fn visit_map<A>(mut self, mut map: A) -> Result<(), A::Error>
    where
        A: MapAccess<'de>,
    {
        self.scalar()?;
        while let Some(key_bytes) = map.next_key_seed(JsonKeyLengthSeed)? {
            self.estimate
                .add_object_entry(key_bytes)
                .map_err(A::Error::custom)?;
            map.next_value_seed(JsonEstimateSeed {
                estimate: self.estimate,
            })?;
        }
        Ok(())
    }
}

fn estimate_json_retained_bytes(bytes: &[u8]) -> Result<usize, serde_json::Error> {
    let mut estimate = JsonRetainedEstimate::default();
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    JsonEstimateSeed {
        estimate: &mut estimate,
    }
    .deserialize(&mut deserializer)?;
    deserializer.end()?;
    Ok(estimate.bytes)
}

impl MetadataReader {
    pub(crate) fn standalone(store: Arc<dyn ObjectStore>) -> Self {
        let shared = SharedObjectCache::new(
            DEFAULT_STANDALONE_IMPORT_BUDGET_BYTES,
            DEFAULT_MAX_METADATA_OBJECT_BYTES,
        );
        Self::with_shared_cache(store, shared)
    }

    pub(crate) fn with_shared_cache(
        store: Arc<dyn ObjectStore>,
        shared: Arc<SharedObjectCache>,
    ) -> Self {
        let id = NEXT_IMPORT_NAMESPACE.fetch_add(1, Ordering::Relaxed);
        let namespace: Arc<str> = Arc::from(format!("metadata-import:{id}"));
        let cache = CachedStore::with_shared_cache_limit(
            store,
            Arc::clone(&namespace),
            Arc::clone(&shared),
            DEFAULT_MAX_METADATA_OBJECT_BYTES,
        );
        Self(Arc::new(MetadataReaderInner {
            cache,
            shared,
            namespace,
        }))
    }

    pub(crate) async fn read(&self, path: &str) -> Result<CachedBytes, StoreError> {
        self.0
            .cache
            .get_bytes(&Path::from(path))
            .await
            .map_err(StoreError::from)
    }

    /// Read and parse one metadata JSON object while charging both the raw
    /// cached body and a structural upper estimate of the retained tree.
    pub(crate) async fn read_json<T>(&self, path: &str) -> Result<ParsedJson<T>, StoreError>
    where
        T: DeserializeOwned,
    {
        let bytes = self.read(path).await?;
        // Both passes may use serde_json's reusable unescape scratch. Hold a
        // geometric-growth bound from before preflight through completion of
        // the real parse; it cannot be confused with retained-tree ownership.
        let workspace_bytes = bytes
            .len()
            .checked_mul(2)
            .and_then(|bytes| bytes.checked_add(JSON_ALLOCATION_BOOKKEEPING_BOUND))
            .ok_or_else(|| {
                StoreError::Schema(format!(
                    "JSON parser workspace estimate overflowed for {path}"
                ))
            })?;
        let workspace = self
            .0
            .shared
            .reserve_resident(MemoryCategory::MetadataParsed, workspace_bytes)
            .ok_or_else(|| {
                StoreError::Schema(format!(
                    "JSON parser workspace in {path} requires {workspace_bytes} bytes; process resident budget is exhausted"
                ))
            })?;
        let parsed_bytes = estimate_json_retained_bytes(&bytes)
            .map_err(|error| StoreError::Schema(format!("invalid JSON in {path}: {error}")))?;
        let reservation = self
            .0
            .shared
            .reserve_resident(MemoryCategory::MetadataParsed, parsed_bytes)
            .ok_or_else(|| {
                StoreError::Schema(format!(
                    "parsed JSON in {path} requires an estimated {parsed_bytes} bytes; process resident budget is exhausted"
                ))
            })?;
        let value = serde_json::from_slice(&bytes)
            .map_err(|error| StoreError::Schema(format!("invalid JSON in {path}: {error}")))?;
        drop(workspace);
        Ok(ParsedJson {
            value,
            _reservation: reservation,
        })
    }

    /// Retain a general JSON tree with its structural reservation attached.
    pub(crate) async fn read_json_value(&self, path: &str) -> Result<ParsedJsonValue, StoreError> {
        self.read_json(path).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use object_store::ObjectStoreExt;
    use object_store::memory::InMemory;

    fn repeated_singleton_arrays(count: usize) -> Vec<u8> {
        let mut payload = Vec::with_capacity(count * 4 + 1);
        payload.push(b'[');
        for index in 0..count {
            if index > 0 {
                payload.push(b',');
            }
            payload.extend_from_slice(b"[0]");
        }
        payload.push(b']');
        payload
    }

    fn scalar_array(count: usize) -> Vec<u8> {
        let mut payload = Vec::with_capacity(count * 2 + 1);
        payload.push(b'[');
        for index in 0..count {
            if index > 0 {
                payload.push(b',');
            }
            payload.push(b'0');
        }
        payload.push(b']');
        payload
    }

    #[tokio::test]
    async fn oversized_metadata_is_rejected_and_import_namespace_is_reclaimed() {
        let store = Arc::new(InMemory::new());
        store
            .put(
                &Path::from("zarr.json"),
                vec![b'x'; DEFAULT_MAX_METADATA_OBJECT_BYTES + 1].into(),
            )
            .await
            .unwrap();
        let shared = SharedObjectCache::new(64 * 1024 * 1024, 64 * 1024 * 1024);
        let reader = MetadataReader::with_shared_cache(store, Arc::clone(&shared));

        let error = reader.read("zarr.json").await.unwrap_err();
        assert!(error.to_string().contains("per-object limit"));
        assert_eq!(shared.memory_snapshot().total_bytes, 0);

        drop(reader);
        assert_eq!(shared.memory_snapshot().total_bytes, 0);
    }

    #[tokio::test]
    async fn concurrent_import_metadata_shares_the_process_resident_ceiling() {
        let store = Arc::new(InMemory::new());
        store
            .put(&Path::from("a.json"), vec![b'a'; 10].into())
            .await
            .unwrap();
        store
            .put(&Path::from("b.json"), vec![b'b'; 10].into())
            .await
            .unwrap();
        let shared = SharedObjectCache::new(1_400, 15);
        let first_reader = MetadataReader::with_shared_cache(store.clone(), Arc::clone(&shared));
        let second_reader = MetadataReader::with_shared_cache(store, Arc::clone(&shared));

        let first = first_reader.read("a.json").await.unwrap();
        let error = second_reader.read("b.json").await.unwrap_err();
        assert!(error.to_string().contains("process resident budget"));
        assert!(shared.memory_snapshot().total_bytes <= 1_400);

        drop(first);
        let second = second_reader.read("b.json").await.unwrap();
        assert_eq!(&second[..], b"bbbbbbbbbb");
        assert!(shared.memory_snapshot().total_bytes <= 1_400);
    }

    #[tokio::test]
    async fn nested_array_amplification_above_32x_is_rejected_before_value_fanout() {
        let store = Arc::new(InMemory::new());
        let payload = repeated_singleton_arrays(10_000);
        assert!(payload.len() <= DEFAULT_MAX_METADATA_OBJECT_BYTES);
        let retained_estimate = estimate_json_retained_bytes(&payload).unwrap();
        assert!(
            retained_estimate > payload.len() * 40,
            "the structural witness must exceed the disproven 32x heuristic"
        );
        let budget_bytes = payload.len() * 35 + 4_096;
        store
            .put(&Path::from("zarr.json"), payload.into())
            .await
            .unwrap();
        let shared = SharedObjectCache::new(budget_bytes, DEFAULT_MAX_METADATA_OBJECT_BYTES);
        let reader = MetadataReader::with_shared_cache(store, Arc::clone(&shared));

        let error = reader.read_json_value("zarr.json").await.unwrap_err();

        assert!(error.to_string().contains("parsed JSON"), "{error}");
        let snapshot = shared.memory_snapshot();
        assert_eq!(snapshot.metadata_parsed_bytes, 0);
        assert!(snapshot.total_bytes <= snapshot.max_bytes);
        drop(reader);
        assert_eq!(shared.memory_snapshot().total_bytes, 0);
    }

    #[test]
    fn tiny_object_estimate_charges_full_node_not_wire_size() {
        let payload = br#"{"a":0}"#;
        let estimate = estimate_json_retained_bytes(payload).unwrap();
        assert!(estimate > payload.len() * 64);
        assert!(estimate > size_of::<serde_json::Value>());
    }

    #[tokio::test]
    async fn parsed_json_claim_is_held_for_value_lifetime_and_released_for_retry() {
        let store = Arc::new(InMemory::new());
        let payload = scalar_array(1_024);
        store
            .put(&Path::from("a.json"), payload.clone().into())
            .await
            .unwrap();
        store
            .put(&Path::from("b.json"), payload.clone().into())
            .await
            .unwrap();
        let parsed_bytes = estimate_json_retained_bytes(&payload).unwrap();
        let budget_bytes = parsed_bytes + payload.len() * 6 + 4_096;
        let shared = SharedObjectCache::new(budget_bytes, 4 * 1024);
        let first_reader = MetadataReader::with_shared_cache(store.clone(), Arc::clone(&shared));
        let second_reader = MetadataReader::with_shared_cache(store, Arc::clone(&shared));

        let first = first_reader.read_json_value("a.json").await.unwrap();
        assert_eq!(shared.memory_snapshot().metadata_parsed_bytes, parsed_bytes);
        let error = second_reader.read_json_value("b.json").await.unwrap_err();
        assert!(error.to_string().contains("process resident budget"));
        assert_eq!(shared.memory_snapshot().metadata_parsed_bytes, parsed_bytes);
        assert!(shared.memory_snapshot().total_bytes <= shared.memory_snapshot().max_bytes);

        drop(first);
        let second = second_reader.read_json_value("b.json").await.unwrap();
        assert_eq!(second.as_array().unwrap().len(), 1_024);
        assert_eq!(shared.memory_snapshot().metadata_parsed_bytes, parsed_bytes);
        drop(second);
        drop(first_reader);
        drop(second_reader);
        assert_eq!(shared.memory_snapshot().total_bytes, 0);
    }
}
