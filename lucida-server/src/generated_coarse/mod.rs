use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use lucida_content::url::{SourceRevision, SourceVersion};
use lucida_content::{
    DataType, DatasetId, DatasetKind, DatasetManifest, GeneratedLevelInfo,
    GeneratedLevelProvenance, GeneratedLevelRole, ImageId, ImageSpec, LevelGeometry,
};
use lucida_core::protocol::{
    ClientId, ServerMessage, ViewerInterestChunkKey, ViewerInterestHint, ViewerInterestLane,
};
use lucida_protocol::{
    FailureCode, FailureDescriptor, GeneratedAvailabilityDelta, GeneratedAvailabilityIndex,
    GeneratedAvailabilitySnapshot, GeneratedChunkStatus, GeneratedChunkStatusUpdate,
    GeneratedLevelAvailability, GeneratedLevelSummary, MAX_GENERATED_RUNTIME_CHUNKS,
};
use lucida_store::budget::{MemoryCategory, MemoryReservation};
use lucida_store::cache::{CachedStore, SharedObjectCache};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, Notify, mpsc, oneshot};

use crate::binding::ChunkResolver;
use crate::session::Session;
use crate::source_volume::{VolumeReadError, VolumeRegion, fetch_volume_region};
use crate::{BroadcastEvent, BroadcastSender};

mod availability;
mod cache;
mod materialize;
mod planning;
mod scheduler;

pub use availability::merge_generated_availability_into_manifest;
use availability::{GeneratedDeltaBroadcaster, broadcast_generated_delta};
pub(crate) use cache::GeneratedStatusBudget;
#[cfg(test)]
use cache::hex16;
#[cfg(test)]
use cache::{
    AtomicWriteStage, DerivedChunkState, DerivedReadinessIndex, atomic_temp_cleanup_order_probe,
    disk_resource_usage_for_test, initialized_disk_telemetry_for_test,
};
pub use cache::{
    DerivedCacheStorage, DerivedCacheTelemetry, DerivedChunkCache, DerivedChunkLookup,
    GeneratedChunkReadHandle, GeneratedReadyBytes,
};
#[cfg(test)]
pub(crate) use materialize::publish_generated_delta_for_test;
#[cfg(test)]
use materialize::*;
use materialize::{GeneratedChunkCoords, MaterializeOneResult, materialize_generated_coarse_key};
pub use materialize::{materialize_generated_coarse_plan, publish_generated_level_availability};
#[cfg(test)]
use planning::grid_shape;
pub use planning::{
    GeneratedChunkJobKey, GeneratedCoarseConfig, GeneratedCoarsePlan,
    plan_generated_coarse_for_manifest, plan_generated_coarse_for_source,
};
#[cfg(test)]
use scheduler::current_unix_millis;
pub use scheduler::{
    GeneratedCoarseService, GeneratedSchedulerTelemetry, GeneratedSchedulingConfig,
    GeneratedSchedulingLane, GeneratedWorkItem, GeneratedWorkKey,
};

pub const GENERATED_COARSE_GENERATOR_VERSION: &str = "generated-coarse-v2";
const DEFAULT_TARGET_LONG_AXIS: u64 = 512;
const DEFAULT_CHUNK_LONG_AXIS: u64 = 256;
const DEFAULT_MAX_CHUNK_BYTES: u64 = 2 * 1024 * 1024;
const DOWNSAMPLE_ALGORITHM_VERSION: &str = "max-pool-v1";
const DISK_MAINTENANCE_QUEUE_CAPACITY: usize = 4_096;
const GENERATED_DELTA_BATCH_SIZE: usize = 256;
const GENERATED_DELTA_QUEUE_CAPACITY: usize = 64;
const GENERATED_DELTA_FLUSH_INTERVAL: Duration = Duration::from_millis(16);

// Recovery is deliberately bounded independently of a dataset's theoretical
// T/C cardinality. Persisted indexes are hints: entries beyond the cap can be
// regenerated lazily instead of making workspace restore allocate in
// proportion to an untrusted shape.
const MAX_RECOVERED_STATUS_ENTRIES: usize = 65_536;
const MAX_READINESS_INDEX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_INCREMENTAL_STATUS_BYTES: u64 = 64 * 1024;
const MAX_CHECKPOINT_IDENTITIES: usize = 4_096;
const MAX_CHECKPOINT_STATUS_ENTRIES: usize = MAX_RECOVERED_STATUS_ENTRIES;
const MAX_CHECKPOINT_SCANNED_STATUS_ENTRIES: usize = MAX_CHECKPOINT_STATUS_ENTRIES * 4;
const CHECKPOINT_TIMEOUT: Duration = Duration::from_secs(5);

fn chunk_key(level_index: u32, t: u32, c: u32, z: u64, y: u64, x: u64) -> String {
    format!("{level_index}/{t}/{c}/{z}/{y}/{x}")
}

fn parse_generated_chunk_key(key: &str) -> Option<GeneratedChunkCoords> {
    let mut parts = key.split('/');
    let level_index = parts.next()?.parse().ok()?;
    let t = parts.next()?.parse().ok()?;
    let c = parts.next()?.parse().ok()?;
    let z = parts.next()?.parse().ok()?;
    let y = parts.next()?.parse().ok()?;
    let x = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(GeneratedChunkCoords {
        level_index,
        t,
        c,
        z,
        y,
        x,
    })
}

fn checked_product(values: &[u64]) -> Option<u64> {
    values
        .iter()
        .try_fold(1_u64, |acc, value| acc.checked_mul(*value))
}

fn data_type_size(data_type: DataType) -> u64 {
    match data_type {
        DataType::Uint8 => 1,
        DataType::Uint16 => 2,
        DataType::Uint32 | DataType::Float32 => 4,
        DataType::Float64 => 8,
    }
}

#[cfg(test)]
fn downsample_u16_max(
    input: &[u16],
    input_dims: [u32; 3],
    output_dims: [u32; 3],
) -> Result<Vec<u16>, String> {
    let [in_z, in_y, in_x] = input_dims;
    let [out_z, out_y, out_x] = output_dims;
    let expected = (in_z as usize)
        .checked_mul(in_y as usize)
        .and_then(|v| v.checked_mul(in_x as usize))
        .ok_or_else(|| "source generated coarse volume is too large".to_string())?;
    if input.len() != expected {
        return Err(format!(
            "source generated coarse volume has {} voxels, expected {expected}",
            input.len()
        ));
    }
    if input_dims == output_dims {
        return Ok(input.to_vec());
    }

    let output_len = (out_z as usize)
        .checked_mul(out_y as usize)
        .and_then(|v| v.checked_mul(out_x as usize))
        .ok_or_else(|| "output generated coarse volume is too large".to_string())?;
    let mut output = vec![0_u16; output_len];
    let out_stride_y = out_x as usize;
    let out_stride_z = (out_y as usize) * out_stride_y;
    let in_stride_y = in_x as usize;
    let in_stride_z = (in_y as usize) * in_stride_y;

    for oz in 0..out_z {
        let (z0, z1) = scale_range(oz, out_z, in_z);
        for oy in 0..out_y {
            let (y0, y1) = scale_range(oy, out_y, in_y);
            for ox in 0..out_x {
                let (x0, x1) = scale_range(ox, out_x, in_x);
                let mut value = 0_u16;
                for iz in z0..z1 {
                    for iy in y0..y1 {
                        let base = (iz as usize) * in_stride_z + (iy as usize) * in_stride_y;
                        for ix in x0..x1 {
                            value = value.max(input[base + ix as usize]);
                        }
                    }
                }
                let out_idx =
                    (oz as usize) * out_stride_z + (oy as usize) * out_stride_y + ox as usize;
                output[out_idx] = value;
            }
        }
    }
    Ok(output)
}

fn scale_range(out_index: u32, out_len: u32, in_len: u32) -> (u32, u32) {
    let start = ((out_index as u64) * (in_len as u64) / (out_len as u64)) as u32;
    let end = (((out_index as u64 + 1) * (in_len as u64)).div_ceil(out_len as u64)) as u32;
    let end = end.max(start + 1).min(in_len);
    (start.min(in_len.saturating_sub(1)), end)
}

#[cfg(test)]
fn encode_generated_chunk_bytes(
    output: &[u16],
    level: &LevelGeometry,
    gz: u64,
    gy: u64,
    gx: u64,
    output_data_type: DataType,
) -> Vec<u8> {
    let chunk_z = level.chunk_shape[2];
    let chunk_y = level.chunk_shape[3];
    let chunk_x = level.chunk_shape[4];
    let level_z = level.shape[2];
    let level_y = level.shape[3];
    let level_x = level.shape[4];
    let chunk_voxels = (chunk_z as usize) * (chunk_y as usize) * (chunk_x as usize);
    let mut chunk = vec![0_u16; chunk_voxels];
    let out_stride_y = level_x as usize;
    let out_stride_z = (level_y as usize) * out_stride_y;
    let chunk_stride_y = chunk_x as usize;
    let chunk_stride_z = (chunk_y as usize) * chunk_stride_y;
    let z0 = gz * chunk_z;
    let y0 = gy * chunk_y;
    let x0 = gx * chunk_x;
    let z_end = (z0 + chunk_z).min(level_z);
    let y_end = (y0 + chunk_y).min(level_y);
    let x_end = (x0 + chunk_x).min(level_x);

    for z in z0..z_end {
        for y in y0..y_end {
            let src_base = (z as usize) * out_stride_z + (y as usize) * out_stride_y;
            let dst_base =
                ((z - z0) as usize) * chunk_stride_z + ((y - y0) as usize) * chunk_stride_y;
            for x in x0..x_end {
                chunk[dst_base + (x - x0) as usize] = output[src_base + x as usize];
            }
        }
    }

    encode_generated_chunk_values(&chunk, output_data_type)
}

fn encode_generated_chunk_values(chunk: &[u16], output_data_type: DataType) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(chunk.len() * data_type_size(output_data_type) as usize);
    for value in chunk {
        encode_u16_as_data_type(*value, output_data_type, &mut bytes);
    }
    bytes
}

fn encode_u16_as_data_type(value: u16, data_type: DataType, out: &mut Vec<u8>) {
    match data_type {
        DataType::Uint8 => out.push(value.min(u8::MAX as u16) as u8),
        DataType::Uint16 => out.extend_from_slice(&value.to_le_bytes()),
        DataType::Uint32 => out.extend_from_slice(&(value as u32).to_le_bytes()),
        DataType::Float32 => {
            out.extend_from_slice(&((value as f32) / (u16::MAX as f32)).to_le_bytes())
        }
        DataType::Float64 => {
            out.extend_from_slice(&((value as f64) / (u16::MAX as f64)).to_le_bytes())
        }
    }
}

fn hex32(bytes: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
    }
    out
}

#[cfg(test)]
mod tests;
