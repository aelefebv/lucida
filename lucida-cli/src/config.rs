use std::collections::BTreeMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::CliError;

pub const DEFAULT_SERVER: &str = "http://localhost:9876";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub servers: BTreeMap<String, ServerConfig>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

impl CliConfig {
    pub fn server_config(&self, server_url: &str) -> Option<&ServerConfig> {
        self.servers.get(server_url)
    }

    pub fn server_config_mut(&mut self, server_url: &str) -> &mut ServerConfig {
        self.servers.entry(server_url.to_string()).or_default()
    }

    pub fn workspace_for_server(&self, server_url: &str) -> Option<&str> {
        self.server_config(server_url)?.workspace.as_deref()
    }

    pub fn set_workspace_for_server(&mut self, server_url: &str, workspace: impl Into<String>) {
        self.server_config_mut(server_url).workspace = Some(workspace.into());
    }

    pub fn token_for_server(&self, server_url: &str) -> Option<&str> {
        self.server_config(server_url)?.token.as_deref()
    }

    pub fn set_token_for_server(&mut self, server_url: &str, token: impl Into<String>) {
        self.server_config_mut(server_url).token = Some(token.into());
    }

    pub fn clear_token_for_server(&mut self, server_url: &str) -> bool {
        self.server_config_mut(server_url).token.take().is_some()
    }
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
        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        let mut file = options.open(&self.path).map_err(|error| {
            CliError::config(format!(
                "failed to write config {}: {error}",
                self.path.display()
            ))
        })?;
        file.write_all(format!("{raw}\n").as_bytes())
            .map_err(|error| {
                CliError::config(format!(
                    "failed to write config {}: {error}",
                    self.path.display()
                ))
            })?;
        #[cfg(unix)]
        {
            fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600)).map_err(
                |error| {
                    CliError::config(format!(
                        "failed to set permissions on {}: {error}",
                        self.path.display()
                    ))
                },
            )?;
        }
        Ok(())
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
            servers: BTreeMap::from([(
                "http://127.0.0.1:9988".to_string(),
                ServerConfig {
                    workspace: Some("workspace-1".to_string()),
                    token: Some("lucida_pat_test".to_string()),
                },
            )]),
        };

        store.save(&config).unwrap();
        assert_eq!(store.load().unwrap(), config);

        let _ = std::fs::remove_file(path);
    }
}
