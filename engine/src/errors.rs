use std::error::Error;
use std::fmt::{Display, Formatter};

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
