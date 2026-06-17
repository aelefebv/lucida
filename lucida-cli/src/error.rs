use std::fmt;

use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[allow(dead_code)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Config,
    InvalidServer,
    UnreachableServer,
    Unauthenticated,
    Unauthorized,
    MissingResource,
    AmbiguousName,
    ArchivedWorkspace,
    DatasetOpenFailure,
    SessionDisconnect,
    RejectedCommand,
    Protocol,
    Io,
    Network,
    Unexpected,
}

impl ErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Config => "config",
            ErrorKind::InvalidServer => "invalid_server",
            ErrorKind::UnreachableServer => "unreachable_server",
            ErrorKind::Unauthenticated => "unauthenticated",
            ErrorKind::Unauthorized => "unauthorized",
            ErrorKind::MissingResource => "missing_resource",
            ErrorKind::AmbiguousName => "ambiguous_name",
            ErrorKind::ArchivedWorkspace => "archived_workspace",
            ErrorKind::DatasetOpenFailure => "dataset_open_failure",
            ErrorKind::SessionDisconnect => "session_disconnect",
            ErrorKind::RejectedCommand => "rejected_command",
            ErrorKind::Protocol => "protocol",
            ErrorKind::Io => "io",
            ErrorKind::Network => "network",
            ErrorKind::Unexpected => "unexpected",
        }
    }

    pub fn exit_code(self) -> i32 {
        match self {
            ErrorKind::Unauthenticated => 2,
            ErrorKind::Unauthorized => 3,
            ErrorKind::MissingResource => 4,
            ErrorKind::AmbiguousName => 5,
            ErrorKind::ArchivedWorkspace => 6,
            ErrorKind::Config | ErrorKind::InvalidServer => 64,
            ErrorKind::UnreachableServer
            | ErrorKind::DatasetOpenFailure
            | ErrorKind::SessionDisconnect
            | ErrorKind::RejectedCommand
            | ErrorKind::Protocol
            | ErrorKind::Io
            | ErrorKind::Network
            | ErrorKind::Unexpected => 1,
        }
    }
}

#[derive(Debug)]
pub struct CliError {
    pub kind: ErrorKind,
    pub message: String,
    context: Map<String, Value>,
}

impl CliError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            context: Map::new(),
        }
    }

    pub fn config(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Config, message)
    }

    pub fn invalid_server(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidServer, message)
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Network, message)
    }

    pub fn exit_code(&self) -> i32 {
        self.kind.exit_code()
    }

    pub fn with_context<T: Serialize>(mut self, key: impl Into<String>, value: T) -> Self {
        if let Ok(value) = serde_json::to_value(value) {
            self.context.insert(key.into(), value);
        }
        self
    }

    pub fn to_json(&self) -> serde_json::Value {
        let mut error = Map::new();
        error.insert("kind".to_string(), serde_json::json!(self.kind));
        error.insert("message".to_string(), serde_json::json!(self.message));
        for (key, value) in &self.context {
            error.insert(key.clone(), value.clone());
        }
        serde_json::json!({ "error": error })
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind.as_str(), self.message)
    }
}

impl std::error::Error for CliError {}

impl From<std::io::Error> for CliError {
    fn from(error: std::io::Error) -> Self {
        Self::new(ErrorKind::Io, error.to_string())
    }
}

impl From<serde_json::Error> for CliError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(ErrorKind::Protocol, error.to_string())
    }
}

impl From<reqwest::Error> for CliError {
    fn from(error: reqwest::Error) -> Self {
        if error.is_connect() || error.is_timeout() {
            Self::new(ErrorKind::UnreachableServer, error.to_string())
        } else {
            Self::network(error.to_string())
        }
    }
}
