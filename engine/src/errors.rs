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
        }
    }
}

impl Error for SessionError {}
