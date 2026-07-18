#[cfg(any(
    target_os = "macos",
    target_os = "windows",
    all(unix, not(target_os = "macos"))
))]
use std::process::Command;
use std::time::Duration;

use base64::Engine;
use rand::RngCore;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use lucida_core::auth_principal::AuthPrincipal;

use crate::credentials::CredentialStorage;
use crate::error::{CliError, ErrorKind};
use crate::http::{api_url, bounded_json, http_client};

const POLL_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone)]
pub struct AuthClient {
    base_url: String,
    http: reqwest::Client,
}

impl AuthClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            http: http_client(),
        }
    }

    pub async fn whoami(&self, token: Option<&str>) -> Result<AuthPrincipal, CliError> {
        let url = api_url(&self.base_url, &["auth", "whoami"])?;
        let mut request = self
            .http
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await?;
        match response.status() {
            status if status.is_success() => bounded_json::<AuthPrincipal>(response).await,
            StatusCode::UNAUTHORIZED => Err(CliError::new(
                ErrorKind::Unauthenticated,
                "not authenticated; run `lucida auth login`",
            )),
            status => Err(CliError::new(
                ErrorKind::Protocol,
                format!("unexpected /auth/whoami response: HTTP {}", status.as_u16()),
            )),
        }
    }

    pub async fn start_login(
        &self,
        name: &str,
        raw_token: &str,
        expires_in_seconds: Option<u64>,
    ) -> Result<CliAuthStartResponse, CliError> {
        let url = api_url(&self.base_url, &["auth", "cli", "start"])?;
        let body = CliAuthStartRequest {
            name,
            token_hash: &hash_token(raw_token),
            expires_in_seconds,
        };
        let response = self.http.post(url).json(&body).send().await?;
        match response.status() {
            status if status.is_success() => bounded_json::<CliAuthStartResponse>(response).await,
            status => Err(CliError::new(
                ErrorKind::Protocol,
                format!(
                    "unexpected /auth/cli/start response: HTTP {}",
                    status.as_u16()
                ),
            )),
        }
    }

    pub async fn poll_login(
        &self,
        poll_path: &str,
        poll_token: &str,
    ) -> Result<PollOutcome, CliError> {
        let segments = poll_path
            .trim_start_matches('/')
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        let url = api_url(&self.base_url, &segments)?;
        let response = self.http.get(url).bearer_auth(poll_token).send().await?;
        match response.status() {
            StatusCode::ACCEPTED => Ok(PollOutcome::Pending),
            status if status.is_success() => {
                let body = bounded_json::<CliAuthPollResponse>(response).await?;
                Ok(PollOutcome::Approved(body))
            }
            StatusCode::GONE => Ok(PollOutcome::Expired),
            StatusCode::UNAUTHORIZED => Err(CliError::new(
                ErrorKind::Unauthenticated,
                "CLI login poll token was rejected",
            )),
            status => Err(CliError::new(
                ErrorKind::Protocol,
                format!(
                    "unexpected /auth/cli/poll response: HTTP {}",
                    status.as_u16()
                ),
            )),
        }
    }

    pub async fn revoke_current(&self, raw_token: &str) -> Result<bool, CliError> {
        let url = api_url(&self.base_url, &["auth", "tokens", "revoke-current"])?;
        let response = self.http.post(url).bearer_auth(raw_token).send().await?;
        match response.status() {
            status if status.is_success() => Ok(true),
            StatusCode::UNAUTHORIZED => Ok(false),
            status => Err(CliError::new(
                ErrorKind::Protocol,
                format!(
                    "unexpected /auth/tokens/revoke-current response: HTTP {}",
                    status.as_u16()
                ),
            )),
        }
    }
}

#[derive(Debug, Serialize)]
struct CliAuthStartRequest<'a> {
    name: &'a str,
    token_hash: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_in_seconds: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CliAuthStartResponse {
    pub status: String,
    pub request_id: String,
    pub user_code: String,
    pub approval_path: String,
    pub poll_path: String,
    pub poll_token: String,
    pub expires_at: String,
    pub token_expires_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CliAuthPollResponse {
    pub status: String,
    pub email: Option<String>,
    pub token_id: Option<String>,
    pub token_name: Option<String>,
    pub token_expires_at: Option<String>,
}

#[derive(Debug)]
pub enum PollOutcome {
    Pending,
    Approved(CliAuthPollResponse),
    Expired,
}

#[derive(Debug, Serialize)]
pub struct LoginResult {
    pub server: String,
    pub approved_email: Option<String>,
    pub token_id: Option<String>,
    pub token_name: Option<String>,
    pub token_expires_at: Option<String>,
    pub token_storage: CredentialStorage,
    pub config_path: String,
}

pub fn generate_raw_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    format!(
        "lucida_pat_{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    )
}

pub fn hash_token(raw_token: &str) -> String {
    blake3::hash(raw_token.as_bytes()).to_hex().to_string()
}

pub fn poll_interval() -> Duration {
    POLL_INTERVAL
}

pub fn open_browser(url: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        return Command::new("open")
            .arg(url)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
    #[cfg(target_os = "windows")]
    {
        return Command::new("cmd")
            .args(["/C", "start", "", url])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return Command::new("xdg-open")
            .arg(url)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_is_prefixed_and_hash_hides_raw_value() {
        let token = generate_raw_token();
        assert!(token.starts_with("lucida_pat_"));
        let hash = hash_token(&token);
        assert_eq!(hash.len(), 64);
        assert_ne!(hash, token);
    }
}
