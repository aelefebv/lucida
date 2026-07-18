use serde::Serialize;
use std::net::IpAddr;

use crate::config::CliConfig;
use crate::error::CliError;

#[cfg(any(target_os = "macos", test))]
const KEYCHAIN_SERVICE: &str = "lucida-cli";

#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25_300;

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

pub fn resolve_token(
    server_url: &str,
    config: &CliConfig,
) -> Result<Option<EffectiveToken>, CliError> {
    let token = if let Some(token) = std::env::var("LUCIDA_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        Some(EffectiveToken {
            token,
            source: TokenSource::Env,
        })
    } else if let Some(token) = read_keychain_token(server_url) {
        Some(EffectiveToken {
            token,
            source: TokenSource::Keychain,
        })
    } else {
        config
            .token_for_server(server_url)
            .filter(|value| !value.trim().is_empty())
            .map(|token| EffectiveToken {
                token: token.to_string(),
                source: TokenSource::Config,
            })
    };

    if token.is_some() && !token_transport_is_allowed(server_url)? && !allow_insecure_token() {
        return Err(CliError::config(
            "refusing to send a bearer token over non-loopback HTTP; use HTTPS or set \
             LUCIDA_ALLOW_INSECURE_TOKEN=1 for an explicitly trusted test network",
        ));
    }
    Ok(token)
}

fn token_transport_is_allowed(server_url: &str) -> Result<bool, CliError> {
    let url = reqwest::Url::parse(server_url)
        .map_err(|error| CliError::invalid_server(format!("invalid server URL: {error}")))?;
    if url.scheme() == "https" {
        return Ok(true);
    }
    if url.scheme() != "http" {
        return Ok(false);
    }
    let Some(host) = url.host_str() else {
        return Ok(false);
    };
    if host.eq_ignore_ascii_case("localhost") {
        return Ok(true);
    }
    let ip_literal = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    Ok(ip_literal
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback()))
}

fn allow_insecure_token() -> bool {
    std::env::var("LUCIDA_ALLOW_INSECURE_TOKEN").is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes"
        )
    })
}

pub fn store_local_token(
    server_url: &str,
    raw_token: &str,
    config: &mut CliConfig,
) -> CredentialStorage {
    if store_keychain_token(server_url, raw_token).is_ok() {
        config.clear_token_for_server(server_url);
        CredentialStorage::Keychain
    } else {
        config.set_token_for_server(server_url, raw_token);
        CredentialStorage::Config
    }
}

pub fn clear_local_token(server_url: &str, config: &mut CliConfig) -> Result<bool, CliError> {
    clear_local_token_with_delete(server_url, config, delete_keychain_token)
}

fn clear_local_token_with_delete(
    server_url: &str,
    config: &mut CliConfig,
    delete_keychain: impl FnOnce(&str) -> Result<bool, CliError>,
) -> Result<bool, CliError> {
    // Resolve the fallible native operation first. If the Keychain is locked,
    // denied, or otherwise unavailable, retain the config credential as a
    // recoverable source and let the command report the failure truthfully.
    let removed_keychain = delete_keychain(server_url)?;
    let had_config = config.clear_token_for_server(server_url);
    Ok(had_config || removed_keychain)
}

#[cfg(target_os = "macos")]
fn read_keychain_token(server_url: &str) -> Option<String> {
    let (service, account) = keychain_entry(server_url);
    let options =
        security_framework::passwords::PasswordOptions::new_generic_password(service, account);
    let bytes = security_framework::passwords::generic_password(options).ok()?;
    decode_keychain_token(bytes)
}

#[cfg(not(target_os = "macos"))]
fn read_keychain_token(_server_url: &str) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn store_keychain_token(server_url: &str, raw_token: &str) -> Result<(), CliError> {
    let (service, account) = keychain_entry(server_url);
    security_framework::passwords::set_generic_password(service, account, raw_token.as_bytes())
        .map_err(|error| keychain_error("store", error))
}

#[cfg(any(target_os = "macos", test))]
fn keychain_entry(server_url: &str) -> (&'static str, &str) {
    (KEYCHAIN_SERVICE, server_url)
}

#[cfg(any(target_os = "macos", test))]
fn decode_keychain_token(bytes: Vec<u8>) -> Option<String> {
    let token = String::from_utf8(bytes).ok()?.trim().to_string();
    (!token.is_empty()).then_some(token)
}

#[cfg(target_os = "macos")]
fn keychain_error(action: &str, error: security_framework::base::Error) -> CliError {
    CliError::config(format!(
        "failed to {action} token in macOS Keychain: {error}"
    ))
}

#[cfg(not(target_os = "macos"))]
fn store_keychain_token(_server_url: &str, _raw_token: &str) -> Result<(), CliError> {
    Err(CliError::config(
        "OS keychain is not available on this platform",
    ))
}

#[cfg(target_os = "macos")]
fn delete_keychain_token(server_url: &str) -> Result<bool, CliError> {
    let (service, account) = keychain_entry(server_url);
    match security_framework::passwords::delete_generic_password(service, account) {
        Ok(()) => Ok(true),
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(false),
        Err(error) => Err(keychain_error("delete", error)),
    }
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
        assert_eq!(
            config.token_for_server("http://localhost:9876"),
            Some("lucida_pat_test")
        );
        assert_eq!(config.token_for_server("http://elsewhere"), None);
    }

    #[test]
    fn credential_storage_labels_are_stable() {
        assert_eq!(CredentialStorage::Keychain.as_str(), "keychain");
        assert_eq!(CredentialStorage::Config.as_str(), "config");
    }

    #[test]
    fn keychain_entry_and_token_decoding_contracts_are_stable() {
        assert_eq!(
            keychain_entry("https://example.test"),
            (KEYCHAIN_SERVICE, "https://example.test")
        );
        assert_eq!(
            decode_keychain_token(b"  lucida_pat_test\n".to_vec()).as_deref(),
            Some("lucida_pat_test")
        );
        assert_eq!(decode_keychain_token(b" \n".to_vec()), None);
        assert_eq!(decode_keychain_token(vec![0xff]), None);
    }

    #[test]
    fn local_logout_contract_clears_config_when_keychain_is_absent() {
        let server = "https://config-only.example";
        let mut config = CliConfig::default();
        config.set_token_for_server(server, "lucida_pat_config");

        let removed = clear_local_token_with_delete(server, &mut config, |_| Ok(false)).unwrap();

        assert!(removed);
        assert_eq!(config.token_for_server(server), None);
    }

    #[test]
    fn local_logout_contract_reports_deleted_keychain_credential() {
        let server = "https://keychain.example";
        let mut config = CliConfig::default();

        let removed = clear_local_token_with_delete(server, &mut config, |_| Ok(true)).unwrap();

        assert!(removed);
        assert_eq!(config.token_for_server(server), None);
    }

    #[test]
    fn local_logout_contract_reports_no_credential_when_both_stores_are_absent() {
        let server = "https://absent.example";
        let mut config = CliConfig::default();

        let removed = clear_local_token_with_delete(server, &mut config, |_| Ok(false)).unwrap();

        assert!(!removed);
        assert_eq!(config.token_for_server(server), None);
    }

    #[test]
    fn local_logout_contract_propagates_keychain_failure_and_retains_config_credential() {
        let server = "https://locked-keychain.example";
        let mut config = CliConfig::default();
        config.set_token_for_server(server, "lucida_pat_recoverable");

        let error = clear_local_token_with_delete(server, &mut config, |_| {
            Err(CliError::config("macOS Keychain is locked"))
        })
        .unwrap_err();

        assert_eq!(error.kind, crate::error::ErrorKind::Config);
        assert!(error.message.contains("Keychain is locked"));
        assert_eq!(
            config.token_for_server(server),
            Some("lucida_pat_recoverable")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_keychain_api_contract_compiles_without_mutating_credentials() {
        let _: fn(
            security_framework::passwords::PasswordOptions,
        ) -> security_framework::base::Result<Vec<u8>> =
            security_framework::passwords::generic_password;
        let _: fn(&str, &str, &[u8]) -> security_framework::base::Result<()> =
            security_framework::passwords::set_generic_password;
        let _: fn(&str, &str) -> security_framework::base::Result<()> =
            security_framework::passwords::delete_generic_password;
    }

    #[test]
    fn token_transport_allows_https_and_loopback_only_by_default() {
        assert!(token_transport_is_allowed("https://example.test").unwrap());
        assert!(token_transport_is_allowed("http://localhost:9876").unwrap());
        assert!(token_transport_is_allowed("http://127.0.0.1:9876").unwrap());
        assert!(token_transport_is_allowed("http://[::1]:9876").unwrap());
        assert!(!token_transport_is_allowed("http://example.test").unwrap());
    }
}
