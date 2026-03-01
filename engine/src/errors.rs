use std::error::Error;
use std::fmt::{Display, Formatter};

use crate::model::GenerationStage;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    SessionNotFound {
        session_id: String,
    },
    ClientNotFound {
        session_id: String,
        client_id: String,
    },
    SourceNotFound {
        session_id: String,
        source_id: String,
    },
    LayerNotFound {
        session_id: String,
        layer_id: String,
    },
    SourceUnavailable {
        uri: String,
        reason: String,
    },
    GenerationNotFound {
        session_id: String,
        source_id: String,
        generation_seq: u64,
    },
    InvalidGenerationTransition {
        source_id: String,
        generation_seq: u64,
        current_stage: GenerationStage,
        requested_stage: GenerationStage,
    },
    CanonicalCacheBuildFailed {
        source_id: String,
        generation_seq: u64,
        reason: String,
    },
    LeaseUnavailable {
        session_id: String,
        lease_holder_client_id: String,
    },
    LeaseNotStealable {
        session_id: String,
    },
}

impl Display for SessionError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::SessionNotFound { session_id } => {
                write!(f, "session `{session_id}` was not found")
            }
            SessionError::ClientNotFound {
                session_id,
                client_id,
            } => write!(
                f,
                "client `{client_id}` was not found in session `{session_id}`"
            ),
            SessionError::SourceNotFound {
                session_id,
                source_id,
            } => write!(
                f,
                "source `{source_id}` was not found in session `{session_id}`"
            ),
            SessionError::LayerNotFound {
                session_id,
                layer_id,
            } => write!(
                f,
                "layer `{layer_id}` was not found in session `{session_id}`"
            ),
            SessionError::SourceUnavailable { uri, reason } => {
                write!(f, "source `{uri}` is unavailable: {reason}")
            }
            SessionError::GenerationNotFound {
                session_id,
                source_id,
                generation_seq,
            } => write!(
                f,
                "generation `{generation_seq}` for source `{source_id}` was not found in session `{session_id}`"
            ),
            SessionError::InvalidGenerationTransition {
                source_id,
                generation_seq,
                current_stage,
                requested_stage,
            } => write!(
                f,
                "invalid generation transition for source `{source_id}` generation `{generation_seq}`: {:?} -> {:?}",
                current_stage, requested_stage
            ),
            SessionError::CanonicalCacheBuildFailed {
                source_id,
                generation_seq,
                reason,
            } => write!(
                f,
                "canonical cache build failed for source `{source_id}` generation `{generation_seq}`: {reason}"
            ),
            SessionError::LeaseUnavailable {
                session_id,
                lease_holder_client_id,
            } => write!(
                f,
                "lease in session `{session_id}` is held by `{lease_holder_client_id}`"
            ),
            SessionError::LeaseNotStealable { session_id } => {
                write!(f, "lease in session `{session_id}` is not stealable")
            }
        }
    }
}

impl Error for SessionError {}
