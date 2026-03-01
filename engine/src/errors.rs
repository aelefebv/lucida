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
        }
    }
}

impl Error for SessionError {}
