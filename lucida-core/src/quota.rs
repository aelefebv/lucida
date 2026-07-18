//! Shared serialization budgets for the collaborative wire and document model.
//!
//! These are admission limits, not tuning hints.  Keeping them in the core
//! protocol crate means every transport validates the same command/document
//! shapes before mutation, persistence, or broadcast.

use serde::Serialize;
use std::fmt;
use std::io::{self, Write};

/// Maximum JSON payload accepted from one WebSocket client message.
pub const MAX_CLIENT_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
/// Maximum latest-wins presence/interest payload retained per live client.
pub const MAX_EPHEMERAL_MESSAGE_BYTES: usize = 64 * 1024;
/// Maximum serialized durable command, including server-authored commands.
pub const MAX_COMMAND_JSON_BYTES: usize = MAX_CLIENT_MESSAGE_BYTES;
/// Maximum serialized collaborative document persisted by the server.
pub const MAX_DOCUMENT_JSON_BYTES: usize = 24 * 1024 * 1024;
/// Maximum serialized snapshot sent to a client, including runtime state.
pub const MAX_SNAPSHOT_JSON_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug)]
pub enum BoundedJsonError {
    LimitExceeded { limit: usize },
    Serialize(serde_json::Error),
}

impl fmt::Display for BoundedJsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LimitExceeded { limit } => {
                write!(f, "serialized JSON exceeds the {limit}-byte limit")
            }
            Self::Serialize(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for BoundedJsonError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::LimitExceeded { .. } => None,
            Self::Serialize(error) => Some(error),
        }
    }
}

struct BoundedWriter {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl BoundedWriter {
    fn new(limit: usize) -> Self {
        Self {
            // Avoid reserving the entire quota for every small command.
            bytes: Vec::with_capacity(limit.min(8 * 1024)),
            limit,
            exceeded: false,
        }
    }
}

impl Write for BoundedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let Some(next_len) = self.bytes.len().checked_add(buf.len()) else {
            self.exceeded = true;
            return Err(io::Error::other("bounded JSON length overflow"));
        };
        if next_len > self.limit {
            self.exceeded = true;
            return Err(io::Error::other("bounded JSON limit exceeded"));
        }
        self.bytes.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Serialize JSON without ever allocating beyond `limit` bytes.
pub fn to_json_vec_bounded<T>(value: &T, limit: usize) -> Result<Vec<u8>, BoundedJsonError>
where
    T: Serialize + ?Sized,
{
    let mut writer = BoundedWriter::new(limit);
    if let Err(error) = serde_json::to_writer(&mut writer, value) {
        return if writer.exceeded {
            Err(BoundedJsonError::LimitExceeded { limit })
        } else {
            Err(BoundedJsonError::Serialize(error))
        };
    }
    Ok(writer.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_serializer_accepts_exact_limit_and_rejects_next_byte() {
        let value = "abc";
        let encoded = serde_json::to_vec(value).unwrap();
        assert_eq!(to_json_vec_bounded(value, encoded.len()).unwrap(), encoded);
        assert!(matches!(
            to_json_vec_bounded(value, encoded.len() - 1),
            Err(BoundedJsonError::LimitExceeded { .. })
        ));
    }
}
