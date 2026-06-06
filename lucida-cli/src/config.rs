use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::CliError;

pub const DEFAULT_SERVER: &str = "http://localhost:9876";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    pub fn default_path() -> Result<PathBuf, CliError> {
        if let Some(path) = env::var_os("LUCIDA_CONFIG_PATH") {
            return Ok(PathBuf::from(path));
        }

        if let Some(config_home) = env::var_os("XDG_CONFIG_HOME") {
            return Ok(PathBuf::from(config_home)
                .join("lucida")
                .join("config.json"));
        }

        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| CliError::config("HOME is not set; set LUCIDA_CONFIG_PATH"))?;
        Ok(home.join(".config").join("lucida").join("config.json"))
    }

    pub fn default() -> Result<Self, CliError> {
        Ok(Self {
            path: Self::default_path()?,
        })
    }

    #[cfg(test)]
    pub fn with_path(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<CliConfig, CliError> {
        match fs::read_to_string(&self.path) {
            Ok(raw) => serde_json::from_str(&raw)
                .map_err(|error| CliError::config(format!("invalid config JSON: {error}"))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(CliConfig::default()),
            Err(error) => Err(CliError::config(format!(
                "failed to read {}: {error}",
                self.path.display()
            ))),
        }
    }

    pub fn save(&self, config: &CliConfig) -> Result<(), CliError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                CliError::config(format!(
                    "failed to create config directory {}: {error}",
                    parent.display()
                ))
            })?;
        }

        let raw = serde_json::to_string_pretty(config)?;
        fs::write(&self.path, format!("{raw}\n")).map_err(|error| {
            CliError::config(format!(
                "failed to write config {}: {error}",
                self.path.display()
            ))
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerSource {
    Flag,
    Config,
    Default,
}

impl ServerSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            ServerSource::Flag => "flag",
            ServerSource::Config => "config",
            ServerSource::Default => "default",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EffectiveServer {
    pub url: String,
    pub source: ServerSource,
}

pub fn resolve_server(
    override_server: Option<&str>,
    config: &CliConfig,
) -> Result<EffectiveServer, CliError> {
    if let Some(server) = override_server {
        return Ok(EffectiveServer {
            url: normalize_server_base_url(server)?,
            source: ServerSource::Flag,
        });
    }

    if let Some(server) = config.server.as_deref() {
        return Ok(EffectiveServer {
            url: normalize_server_base_url(server)?,
            source: ServerSource::Config,
        });
    }

    Ok(EffectiveServer {
        url: DEFAULT_SERVER.to_string(),
        source: ServerSource::Default,
    })
}

pub fn normalize_server_base_url(input: &str) -> Result<String, CliError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(CliError::invalid_server("server URL cannot be empty"));
    }

    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };

    let mut url = reqwest::Url::parse(&with_scheme)
        .map_err(|error| CliError::invalid_server(format!("invalid server URL: {error}")))?;

    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(CliError::invalid_server(format!(
                "unsupported server URL scheme: {other}"
            )));
        }
    }

    if url.host_str().is_none() {
        return Err(CliError::invalid_server("server URL must include a host"));
    }

    url.set_query(None);
    url.set_fragment(None);

    let mut normalized = url.to_string();
    while normalized.ends_with('/') {
        normalized.pop();
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn normalize_server_base_url_accepts_bare_host() {
        assert_eq!(
            normalize_server_base_url("127.0.0.1:9876").unwrap(),
            "http://127.0.0.1:9876"
        );
    }

    #[test]
    fn normalize_server_base_url_rejects_raw_websocket_urls() {
        assert!(normalize_server_base_url("ws://localhost:9876/ws").is_err());
    }

    #[test]
    fn config_store_round_trips_server() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "lucida-cli-config-test-{}-{unique}.json",
            std::process::id()
        ));
        let store = ConfigStore::with_path(path.clone());
        let config = CliConfig {
            server: Some("http://127.0.0.1:9988".to_string()),
            workspace: None,
        };

        store.save(&config).unwrap();
        assert_eq!(store.load().unwrap(), config);

        let _ = std::fs::remove_file(path);
    }
}
