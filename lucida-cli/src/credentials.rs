#[cfg(target_os = "macos")]
use std::process::Command;

use serde::Serialize;

use crate::config::CliConfig;
use crate::error::CliError;

#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "lucida-cli";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenSource {
    Env,
    Keychain,
    Config,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveToken {
    pub token: String,
    pub source: TokenSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialStorage {
    Keychain,
    Config,
}

impl CredentialStorage {
    pub fn as_str(&self) -> &'static str {
        match self {
            CredentialStorage::Keychain => "keychain",
            CredentialStorage::Config => "config",
        }
    }
}

pub fn resolve_token(server_url: &str, config: &CliConfig) -> Option<EffectiveToken> {
    if let Some(token) = std::env::var("LUCIDA_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return Some(EffectiveToken {
            token,
            source: TokenSource::Env,
        });
    }

    if let Some(token) = read_keychain_token(server_url) {
        return Some(EffectiveToken {
            token,
            source: TokenSource::Keychain,
        });
    }

    config
        .token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|token| EffectiveToken {
            token: token.to_string(),
            source: TokenSource::Config,
        })
}

pub fn store_local_token(
    server_url: &str,
    raw_token: &str,
    config: &mut CliConfig,
) -> CredentialStorage {
    if store_keychain_token(server_url, raw_token).is_ok() {
        config.token = None;
        CredentialStorage::Keychain
    } else {
        config.token = Some(raw_token.to_string());
        CredentialStorage::Config
    }
}

pub fn clear_local_token(server_url: &str, config: &mut CliConfig) -> bool {
    let had_config = config.token.take().is_some();
    let removed_keychain = delete_keychain_token(server_url).unwrap_or(false);
    had_config || removed_keychain
}

#[cfg(target_os = "macos")]
fn read_keychain_token(server_url: &str) -> Option<String> {
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            server_url,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!token.is_empty()).then_some(token)
}

#[cfg(not(target_os = "macos"))]
fn read_keychain_token(_server_url: &str) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn store_keychain_token(server_url: &str, raw_token: &str) -> Result<(), CliError> {
    let output = Command::new("security")
        .args([
            "add-generic-password",
            "-a",
            server_url,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
            raw_token,
            "-U",
        ])
        .output()
        .map_err(|error| CliError::config(format!("failed to run macOS Keychain: {error}")))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(CliError::config(format!(
            "macOS Keychain rejected token storage with status {}",
            output.status
        )))
    }
}

#[cfg(not(target_os = "macos"))]
fn store_keychain_token(_server_url: &str, _raw_token: &str) -> Result<(), CliError> {
    Err(CliError::config(
        "OS keychain is not available on this platform",
    ))
}

#[cfg(target_os = "macos")]
fn delete_keychain_token(server_url: &str) -> Result<bool, CliError> {
    let output = Command::new("security")
        .args([
            "delete-generic-password",
            "-a",
            server_url,
            "-s",
            KEYCHAIN_SERVICE,
        ])
        .output()
        .map_err(|error| CliError::config(format!("failed to run macOS Keychain: {error}")))?;
    Ok(output.status.success())
}

#[cfg(not(target_os = "macos"))]
fn delete_keychain_token(_server_url: &str) -> Result<bool, CliError> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_store_falls_back_to_config() {
        let mut config = CliConfig::default();
        let storage = store_local_token("http://localhost:9876", "lucida_pat_test", &mut config);
        assert_eq!(storage, CredentialStorage::Config);
        assert_eq!(config.token.as_deref(), Some("lucida_pat_test"));
    }

    #[test]
    fn credential_storage_labels_are_stable() {
        assert_eq!(CredentialStorage::Keychain.as_str(), "keychain");
        assert_eq!(CredentialStorage::Config.as_str(), "config");
    }
}
