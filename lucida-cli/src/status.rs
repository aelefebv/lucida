use serde::Serialize;

use lucida_core::auth_principal::AuthPrincipal;

use crate::config::EffectiveServer;
use crate::http::{api_url, bounded_json, bounded_text, http_client};

#[derive(Debug, Clone, Serialize)]
pub struct StatusReport {
    pub ok: bool,
    pub server: EffectiveServer,
    pub checks: ServerChecks,
    pub auth: AuthCheck,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerChecks {
    pub healthz: EndpointCheck,
    pub readyz: EndpointCheck,
    pub version: EndpointCheck,
}

#[derive(Debug, Clone, Serialize)]
pub struct EndpointCheck {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AuthCheck {
    Authenticated { principal: AuthPrincipal },
    Unauthenticated,
    Unknown { error: String },
}

pub struct ServerClient {
    base_url: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl ServerClient {
    pub fn new(base_url: impl Into<String>, token: Option<String>) -> Self {
        Self {
            base_url: base_url.into(),
            token,
            http: http_client(),
        }
    }

    pub async fn status_report(&self, server: EffectiveServer) -> StatusReport {
        let (healthz, readyz, version, auth) = tokio::join!(
            self.text_check("/healthz"),
            self.text_check("/readyz"),
            self.text_check("/version"),
            self.auth_check(),
        );
        let checks = ServerChecks {
            healthz,
            readyz,
            version,
        };
        let ok = checks.healthz.ok && checks.readyz.ok && checks.version.ok;
        StatusReport {
            ok,
            server,
            checks,
            auth,
        }
    }

    async fn text_check(&self, path: &str) -> EndpointCheck {
        let url = match api_url(&self.base_url, &[path.trim_start_matches('/')]) {
            Ok(url) => url,
            Err(error) => {
                return EndpointCheck {
                    ok: false,
                    status: None,
                    body: None,
                    error: Some(error.to_string()),
                };
            }
        };
        match self.http.get(url).send().await {
            Ok(response) => {
                let status = response.status();
                match bounded_text(response).await {
                    Ok(body) => EndpointCheck {
                        ok: status.is_success(),
                        status: Some(status.as_u16()),
                        body: Some(body),
                        error: None,
                    },
                    Err(error) => EndpointCheck {
                        ok: false,
                        status: Some(status.as_u16()),
                        body: None,
                        error: Some(error.to_string()),
                    },
                }
            }
            Err(error) => EndpointCheck {
                ok: false,
                status: None,
                body: None,
                error: Some(error.to_string()),
            },
        }
    }

    async fn auth_check(&self) -> AuthCheck {
        let url = match api_url(&self.base_url, &["auth", "whoami"]) {
            Ok(url) => url,
            Err(error) => {
                return AuthCheck::Unknown {
                    error: error.to_string(),
                };
            }
        };
        let mut request = self
            .http
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(token) = self.token.as_deref() {
            request = request.bearer_auth(token);
        }
        let response = request.send().await;
        match response {
            Ok(response) if response.status().is_success() => {
                match bounded_json::<AuthPrincipal>(response).await {
                    Ok(principal) => AuthCheck::Authenticated { principal },
                    Err(error) => AuthCheck::Unknown {
                        error: error.to_string(),
                    },
                }
            }
            Ok(response) if response.status() == reqwest::StatusCode::UNAUTHORIZED => {
                AuthCheck::Unauthenticated
            }
            Ok(response) => AuthCheck::Unknown {
                error: format!("HTTP {}", response.status().as_u16()),
            },
            Err(error) => AuthCheck::Unknown {
                error: error.to_string(),
            },
        }
    }
}

pub fn format_status_human(report: &StatusReport) -> String {
    let mut lines = Vec::new();
    lines.push(format!(
        "Server: {} ({})",
        report.server.url,
        report.server.source.as_str()
    ));
    lines.push(format!(
        "Health: {}",
        format_endpoint(&report.checks.healthz)
    ));
    lines.push(format!("Ready: {}", format_endpoint(&report.checks.readyz)));
    lines.push(format!(
        "Version: {}",
        format_endpoint(&report.checks.version)
    ));
    lines.push(format!("Auth: {}", format_auth(&report.auth)));
    lines.join("\n")
}

impl StatusReport {
    pub fn is_healthy(&self) -> bool {
        self.ok
    }
}

fn format_endpoint(check: &EndpointCheck) -> String {
    if check.ok {
        match check.body.as_deref() {
            Some(body) if !body.trim().is_empty() => format!("ok ({})", body.trim()),
            _ => "ok".to_string(),
        }
    } else if let Some(status) = check.status {
        format!("failed (HTTP {status})")
    } else if let Some(error) = check.error.as_deref() {
        format!("unreachable ({error})")
    } else {
        "failed".to_string()
    }
}

fn format_auth(auth: &AuthCheck) -> String {
    match auth {
        AuthCheck::Authenticated { principal } => {
            if principal.is_admin {
                format!("{} (admin)", principal.email)
            } else {
                principal.email.clone()
            }
        }
        AuthCheck::Unauthenticated => "unauthenticated".to_string(),
        AuthCheck::Unknown { error } => format!("unknown ({error})"),
    }
}
