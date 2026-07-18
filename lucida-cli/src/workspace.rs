use clap::ValueEnum;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::config::{CliConfig, EffectiveServer};
use crate::credentials::EffectiveToken;
use crate::error::{CliError, ErrorKind};
use crate::http::{api_url, bounded_json, http_client, send_json, websocket_url};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceRole {
    Viewer,
    Editor,
    Owner,
}

impl WorkspaceRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Editor => "editor",
            Self::Owner => "owner",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceLinkAccess {
    Restricted,
    AnyoneWithLink,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    pub role: WorkspaceRole,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub seq: u64,
    pub dataset_count: i64,
    pub default_saved_view_id: Option<String>,
    pub last_opened_at: Option<String>,
    pub pinned_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    pub role: WorkspaceRole,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub seq: u64,
    pub default_saved_view_id: Option<String>,
    pub last_opened_at: Option<String>,
    pub pinned_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceUserState {
    pub workspace_id: String,
    pub last_opened_at: Option<String>,
    pub pinned_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceMember {
    pub email: String,
    pub role: WorkspaceRole,
    pub display_name: String,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSharingSettings {
    pub link_access: WorkspaceLinkAccess,
    pub link_role: WorkspaceRole,
    pub members: Vec<WorkspaceMember>,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceListOutput {
    pub server: EffectiveServer,
    pub include_archived: bool,
    pub workspaces: Vec<WorkspaceSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceTarget {
    pub id: String,
    pub name: String,
    pub role: WorkspaceRole,
    pub archived: bool,
    pub server_url: String,
    pub web_url: String,
    pub ws_url: String,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceUseOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub config_path: String,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceOpenOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub opened: bool,
}

#[derive(Debug, Serialize)]
pub struct WorkspacePinOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub user_state: WorkspaceUserState,
    pub pinned: bool,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceLifecycleOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub action: &'static str,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceSharingOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub sharing: WorkspaceSharingSettings,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceMemberOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub target: WorkspaceTarget,
    pub member: Option<WorkspaceMember>,
    pub email: Option<String>,
    pub action: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceLookupMode {
    ActiveOnly,
    IncludeArchived,
}

pub struct WorkspaceClient {
    base_url: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl WorkspaceClient {
    pub fn new(base_url: impl Into<String>, token: Option<EffectiveToken>) -> Self {
        Self {
            base_url: base_url.into(),
            token: token.map(|effective| effective.token),
            http: http_client(),
        }
    }

    pub async fn list(&self, archived: bool) -> Result<Vec<WorkspaceSummary>, CliError> {
        self.send_decode(
            self.http
                .get(workspace_collection_url(&self.base_url, archived)?),
        )
        .await
    }

    pub async fn create(&self, name: Option<&str>) -> Result<WorkspaceRecord, CliError> {
        let body = serde_json::json!({ "name": name });
        self.send_decode(
            self.http
                .post(workspace_collection_url(&self.base_url, false)?)
                .json(&body),
        )
        .await
    }

    pub async fn get(&self, workspace_id: &str) -> Result<WorkspaceRecord, CliError> {
        self.send_decode(
            self.http
                .get(workspace_api_url(&self.base_url, workspace_id)?),
        )
        .await
    }

    pub async fn open(&self, workspace_id: &str) -> Result<WorkspaceRecord, CliError> {
        self.send_decode(
            self.http
                .post(workspace_api_url(&self.base_url, workspace_id)?),
        )
        .await
    }

    pub async fn set_pinned(
        &self,
        workspace_id: &str,
        pinned: bool,
    ) -> Result<WorkspaceUserState, CliError> {
        let body = serde_json::json!({ "pinned": pinned });
        self.send_decode(
            self.http
                .patch(workspace_api_url_with_suffix(
                    &self.base_url,
                    workspace_id,
                    &["pin"],
                )?)
                .json(&body),
        )
        .await
    }

    pub async fn archive(&self, workspace_id: &str) -> Result<WorkspaceRecord, CliError> {
        self.send_decode(self.http.post(workspace_api_url_with_suffix(
            &self.base_url,
            workspace_id,
            &["archive"],
        )?))
        .await
    }

    pub async fn restore(&self, workspace_id: &str) -> Result<WorkspaceRecord, CliError> {
        self.send_decode(self.http.post(workspace_api_url_with_suffix(
            &self.base_url,
            workspace_id,
            &["restore"],
        )?))
        .await
    }

    pub async fn sharing(&self, workspace_id: &str) -> Result<WorkspaceSharingSettings, CliError> {
        self.send_decode(self.http.get(workspace_api_url_with_suffix(
            &self.base_url,
            workspace_id,
            &["sharing"],
        )?))
        .await
    }

    pub async fn update_link_access(
        &self,
        workspace_id: &str,
        link_access: WorkspaceLinkAccess,
        link_role: WorkspaceRole,
    ) -> Result<WorkspaceSharingSettings, CliError> {
        let body = serde_json::json!({
            "link_access": link_access,
            "link_role": link_role,
        });
        self.send_decode(
            self.http
                .patch(workspace_api_url_with_suffix(
                    &self.base_url,
                    workspace_id,
                    &["sharing"],
                )?)
                .json(&body),
        )
        .await
    }

    pub async fn upsert_member(
        &self,
        workspace_id: &str,
        email: &str,
        role: WorkspaceRole,
        display_name: Option<&str>,
    ) -> Result<WorkspaceMember, CliError> {
        let body = serde_json::json!({
            "email": email,
            "role": role,
            "display_name": display_name,
        });
        self.send_decode(
            self.http
                .post(workspace_api_url_with_suffix(
                    &self.base_url,
                    workspace_id,
                    &["members"],
                )?)
                .json(&body),
        )
        .await
    }

    pub async fn update_member_role(
        &self,
        workspace_id: &str,
        email: &str,
        role: WorkspaceRole,
    ) -> Result<WorkspaceMember, CliError> {
        let body = serde_json::json!({ "role": role });
        self.send_decode(
            self.http
                .patch(workspace_api_url_with_suffix(
                    &self.base_url,
                    workspace_id,
                    &["members", email],
                )?)
                .json(&body),
        )
        .await
    }

    pub async fn remove_member(&self, workspace_id: &str, email: &str) -> Result<(), CliError> {
        self.send(self.http.delete(workspace_api_url_with_suffix(
            &self.base_url,
            workspace_id,
            &["members", email],
        )?))
        .await?;
        Ok(())
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response, CliError> {
        send_json(request, self.token.as_deref(), map_workspace_http_error).await
    }

    async fn send_decode<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, CliError> {
        bounded_json(self.send(request).await?).await
    }
}

fn map_workspace_http_error(status: reqwest::StatusCode, _body: &str) -> CliError {
    match status {
        reqwest::StatusCode::UNAUTHORIZED => CliError::new(
            ErrorKind::Unauthenticated,
            "not authenticated; run `lucida auth login`",
        ),
        reqwest::StatusCode::FORBIDDEN => {
            CliError::new(ErrorKind::Unauthorized, "workspace request was forbidden")
        }
        reqwest::StatusCode::NOT_FOUND => {
            CliError::new(ErrorKind::MissingResource, "workspace was not found")
        }
        reqwest::StatusCode::CONFLICT | reqwest::StatusCode::GONE => {
            CliError::new(ErrorKind::ArchivedWorkspace, "workspace is archived")
        }
        status => CliError::new(
            ErrorKind::Protocol,
            format!("unexpected workspace response: HTTP {}", status.as_u16()),
        ),
    }
}

fn workspace_collection_url(server_url: &str, archived: bool) -> Result<reqwest::Url, CliError> {
    let segments = if archived {
        &["api", "workspaces", "archived"][..]
    } else {
        &["api", "workspaces"][..]
    };
    api_url(server_url, segments)
}

pub async fn resolve_workspace_record(
    client: &WorkspaceClient,
    selector: Option<&str>,
    config: &CliConfig,
    server_url: &str,
    mode: WorkspaceLookupMode,
) -> Result<WorkspaceRecord, CliError> {
    let selector = workspace_selector(selector, config, server_url)?;
    if mode == WorkspaceLookupMode::ActiveOnly && looks_like_workspace_id(selector) {
        return client.get(selector).await;
    }

    let active = client.list(false).await?;
    let archived = if mode == WorkspaceLookupMode::IncludeArchived {
        client.list(true).await?
    } else {
        Vec::new()
    };
    let summary = resolve_workspace_summary_from_summaries(
        Some(selector),
        config,
        server_url,
        &active,
        &archived,
        mode,
    )?;
    if summary.archived_at.is_some() {
        return Ok(WorkspaceRecord::from(summary));
    }
    client.get(&summary.id).await
}

#[cfg(test)]
fn resolve_workspace_id_from_summaries(
    selector: Option<&str>,
    config: &CliConfig,
    server_url: &str,
    active: &[WorkspaceSummary],
    archived: &[WorkspaceSummary],
    mode: WorkspaceLookupMode,
) -> Result<String, CliError> {
    Ok(resolve_workspace_summary_from_summaries(
        selector, config, server_url, active, archived, mode,
    )?
    .id)
}

fn resolve_workspace_summary_from_summaries(
    selector: Option<&str>,
    config: &CliConfig,
    server_url: &str,
    active: &[WorkspaceSummary],
    archived: &[WorkspaceSummary],
    mode: WorkspaceLookupMode,
) -> Result<WorkspaceSummary, CliError> {
    let selector = workspace_selector(selector, config, server_url)?;
    let mut candidates: Vec<WorkspaceSummary> = active.to_vec();
    if mode == WorkspaceLookupMode::IncludeArchived {
        candidates.extend(archived.iter().cloned());
    }

    if let Some(workspace) = candidates
        .iter()
        .find(|workspace| workspace.id == selector)
        .cloned()
    {
        return Ok(workspace);
    }

    let matches: Vec<_> = candidates
        .into_iter()
        .filter(|workspace| workspace.name == selector)
        .collect();

    match matches.len() {
        0 => Err(CliError::new(
            ErrorKind::MissingResource,
            format!("no workspace named or identified by {selector:?}"),
        )),
        1 => Ok(matches[0].clone()),
        _ => {
            let ids = matches
                .iter()
                .map(|workspace| workspace.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            Err(CliError::new(
                ErrorKind::AmbiguousName,
                format!("workspace name {selector:?} is ambiguous; use one of: {ids}"),
            ))
        }
    }
}

fn workspace_selector<'a>(
    selector: Option<&'a str>,
    config: &'a CliConfig,
    server_url: &str,
) -> Result<&'a str, CliError> {
    selector
        .or_else(|| config.workspace_for_server(server_url))
        .ok_or_else(|| {
            CliError::new(
                ErrorKind::MissingResource,
                "no workspace specified; pass one or run `lucida workspace use <id-or-name>`",
            )
        })
}

impl From<WorkspaceSummary> for WorkspaceRecord {
    fn from(summary: WorkspaceSummary) -> Self {
        Self {
            id: summary.id,
            name: summary.name,
            role: summary.role,
            created_by: summary.created_by,
            created_at: summary.created_at,
            updated_at: summary.updated_at,
            archived_at: summary.archived_at,
            seq: summary.seq,
            default_saved_view_id: summary.default_saved_view_id,
            last_opened_at: summary.last_opened_at,
            pinned_at: summary.pinned_at,
        }
    }
}

pub fn target_for(
    server_url: &str,
    workspace: &WorkspaceRecord,
) -> Result<WorkspaceTarget, CliError> {
    let web_url = workspace_web_url(server_url, &workspace.id)?;
    let ws_url = workspace_ws_url(server_url, &workspace.id)?;
    Ok(WorkspaceTarget {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        role: workspace.role,
        archived: workspace.archived_at.is_some(),
        server_url: server_url.to_string(),
        web_url,
        ws_url,
    })
}

pub fn workspace_web_url(server_url: &str, workspace_id: &str) -> Result<String, CliError> {
    Ok(api_url(server_url, &["w", workspace_id])?.to_string())
}

pub fn workspace_ws_url(server_url: &str, workspace_id: &str) -> Result<String, CliError> {
    Ok(websocket_url(server_url, &["ws", "workspaces", workspace_id])?.to_string())
}

fn workspace_api_url(server_url: &str, workspace_id: &str) -> Result<reqwest::Url, CliError> {
    workspace_api_url_with_suffix(server_url, workspace_id, &[])
}

fn workspace_api_url_with_suffix(
    server_url: &str,
    workspace_id: &str,
    suffix: &[&str],
) -> Result<reqwest::Url, CliError> {
    let mut segments = vec!["api", "workspaces", workspace_id];
    segments.extend_from_slice(suffix);
    api_url(server_url, &segments)
}

pub fn format_workspace_list_human(workspaces: &[WorkspaceSummary]) -> String {
    if workspaces.is_empty() {
        return "No workspaces found".to_string();
    }
    workspaces
        .iter()
        .map(|workspace| {
            let mut tags = Vec::new();
            tags.push(workspace.role.as_str().to_string());
            tags.push(format!("{} datasets", workspace.dataset_count));
            if workspace.pinned_at.is_some() {
                tags.push("pinned".to_string());
            }
            if workspace.last_opened_at.is_some() {
                tags.push("recent".to_string());
            }
            if workspace.archived_at.is_some() {
                tags.push("archived".to_string());
            }
            format!(
                "{}  {}  ({})",
                workspace.id,
                workspace.name,
                tags.join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn format_workspace_human(workspace: &WorkspaceRecord, target: &WorkspaceTarget) -> String {
    let archived = if workspace.archived_at.is_some() {
        "yes"
    } else {
        "no"
    };
    format!(
        "Workspace: {}\nID: {}\nRole: {}\nArchived: {}\nURL: {}\nWebSocket: {}",
        workspace.name,
        workspace.id,
        workspace.role.as_str(),
        archived,
        target.web_url,
        target.ws_url,
    )
}

pub fn format_workspace_pin_human(output: &WorkspacePinOutput) -> String {
    let state = if output.pinned { "Pinned" } else { "Unpinned" };
    format!(
        "{state}: {}\nID: {}\nPinned at: {}",
        output.workspace.name,
        output.workspace.id,
        output
            .user_state
            .pinned_at
            .as_deref()
            .unwrap_or("not pinned"),
    )
}

pub fn format_workspace_lifecycle_human(output: &WorkspaceLifecycleOutput) -> String {
    format!(
        "{}: {}\nID: {}\nArchived: {}\nURL: {}",
        output.action,
        output.workspace.name,
        output.workspace.id,
        if output.workspace.archived_at.is_some() {
            "yes"
        } else {
            "no"
        },
        output.target.web_url,
    )
}

pub fn format_workspace_sharing_human(output: &WorkspaceSharingOutput) -> String {
    let link = match output.sharing.link_access {
        WorkspaceLinkAccess::Restricted => "off".to_string(),
        WorkspaceLinkAccess::AnyoneWithLink => {
            format!("anyone with link ({})", output.sharing.link_role.as_str())
        }
    };
    let members = if output.sharing.members.is_empty() {
        "Members: none".to_string()
    } else {
        let rows = output
            .sharing
            .members
            .iter()
            .map(|member| {
                format!(
                    "{}  {}  {}",
                    member.email,
                    member.role.as_str(),
                    member.display_name,
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!("Members:\n{rows}")
    };
    format!(
        "Workspace: {}\nID: {}\nLink: {}\n{}",
        output.workspace.name, output.workspace.id, link, members
    )
}

pub fn format_workspace_member_human(output: &WorkspaceMemberOutput) -> String {
    match output.member.as_ref() {
        Some(member) => format!(
            "{}: {}\nRole: {}\nWorkspace: {} ({})",
            output.action,
            member.email,
            member.role.as_str(),
            output.workspace.name,
            output.workspace.id,
        ),
        None => format!(
            "{}: {}\nWorkspace: {} ({})",
            output.action,
            output.email.as_deref().unwrap_or("member"),
            output.workspace.name,
            output.workspace.id
        ),
    }
}

fn looks_like_workspace_id(selector: &str) -> bool {
    uuid_like(selector)
}

fn uuid_like(selector: &str) -> bool {
    let parts: Vec<&str> = selector.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12]
            .iter()
            .zip(parts.iter())
            .all(|(len, part)| part.len() == *len && part.chars().all(|ch| ch.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(id: &str, name: &str) -> WorkspaceRecord {
        WorkspaceRecord {
            id: id.to_string(),
            name: name.to_string(),
            role: WorkspaceRole::Owner,
            created_by: "dev@local".into(),
            created_at: "2026-06-06T00:00:00Z".into(),
            updated_at: "2026-06-06T00:00:00Z".into(),
            archived_at: None,
            seq: 0,
            default_saved_view_id: None,
            last_opened_at: None,
            pinned_at: None,
        }
    }

    fn summary(id: &str, name: &str) -> WorkspaceSummary {
        WorkspaceSummary {
            id: id.to_string(),
            name: name.to_string(),
            role: WorkspaceRole::Owner,
            created_by: "dev@local".into(),
            created_at: "2026-06-06T00:00:00Z".into(),
            updated_at: "2026-06-06T00:00:00Z".into(),
            archived_at: None,
            seq: 0,
            dataset_count: 0,
            default_saved_view_id: None,
            last_opened_at: None,
            pinned_at: None,
        }
    }

    fn archived_summary(id: &str, name: &str) -> WorkspaceSummary {
        WorkspaceSummary {
            archived_at: Some("2026-06-06T00:00:00Z".into()),
            ..summary(id, name)
        }
    }

    #[test]
    fn workspace_user_state_decodes_server_pin_response() {
        let state: WorkspaceUserState = serde_json::from_value(serde_json::json!({
            "workspace_id": "ws-1",
            "last_opened_at": "2026-06-07T12:00:00Z",
            "pinned_at": "2026-06-07T12:01:00Z"
        }))
        .unwrap();

        assert_eq!(state.workspace_id, "ws-1");
        assert_eq!(state.pinned_at.as_deref(), Some("2026-06-07T12:01:00Z"));
    }

    #[test]
    fn derives_workspace_urls_from_http_server_base() {
        let ws = workspace("abc 123", "Demo");
        let target = target_for("http://127.0.0.1:9876", &ws).unwrap();
        assert_eq!(target.web_url, "http://127.0.0.1:9876/w/abc%20123");
        assert_eq!(target.ws_url, "ws://127.0.0.1:9876/ws/workspaces/abc%20123");
    }

    #[test]
    fn derives_workspace_urls_from_https_server_base() {
        assert_eq!(
            workspace_ws_url("https://lucida.example", "w1").unwrap(),
            "wss://lucida.example/ws/workspaces/w1"
        );
    }

    #[test]
    fn all_workspace_url_surfaces_preserve_reverse_proxy_prefix() {
        let base = "https://lucida.example/tools/lucida?stale=1#frag";
        assert_eq!(
            workspace_collection_url(base, false).unwrap().as_str(),
            "https://lucida.example/tools/lucida/api/workspaces"
        );
        assert_eq!(
            workspace_collection_url(base, true).unwrap().as_str(),
            "https://lucida.example/tools/lucida/api/workspaces/archived"
        );
        assert_eq!(
            workspace_api_url_with_suffix(base, "w 1", &["datasets"])
                .unwrap()
                .as_str(),
            "https://lucida.example/tools/lucida/api/workspaces/w%201/datasets"
        );
        assert_eq!(
            workspace_web_url(base, "w 1").unwrap(),
            "https://lucida.example/tools/lucida/w/w%201"
        );
        assert_eq!(
            workspace_ws_url(base, "w 1").unwrap(),
            "wss://lucida.example/tools/lucida/ws/workspaces/w%201"
        );
    }

    #[test]
    fn all_workspace_url_surfaces_keep_unprefixed_contract() {
        let base = "http://127.0.0.1:9876";
        assert_eq!(
            workspace_collection_url(base, false).unwrap().as_str(),
            "http://127.0.0.1:9876/api/workspaces"
        );
        assert_eq!(
            workspace_api_url(base, "w1").unwrap().as_str(),
            "http://127.0.0.1:9876/api/workspaces/w1"
        );
        assert_eq!(
            workspace_web_url(base, "w1").unwrap(),
            "http://127.0.0.1:9876/w/w1"
        );
        assert_eq!(
            workspace_ws_url(base, "w1").unwrap(),
            "ws://127.0.0.1:9876/ws/workspaces/w1"
        );
    }

    #[test]
    fn uuid_selector_is_treated_as_id() {
        assert!(looks_like_workspace_id(
            "ca7ba7c7-37f8-4f97-988e-a98f8e5d1e62"
        ));
        assert!(!looks_like_workspace_id("Shared analysis"));
        assert!(!looks_like_workspace_id("cli-dev-smoke-20260609-122456"));
    }

    #[test]
    fn resolves_configured_default_workspace() {
        let config = CliConfig {
            ..CliConfig::default()
        };
        let mut config = config;
        config.set_workspace_for_server("http://server", "Team");
        let active = vec![summary("w1", "Team")];

        let id = resolve_workspace_id_from_summaries(
            None,
            &config,
            "http://server",
            &active,
            &[],
            WorkspaceLookupMode::ActiveOnly,
        )
        .unwrap();

        assert_eq!(id, "w1");
    }

    #[test]
    fn explicit_selector_overrides_configured_default() {
        let config = CliConfig {
            ..CliConfig::default()
        };
        let mut config = config;
        config.set_workspace_for_server("http://server", "Default");
        let active = vec![summary("w1", "Default"), summary("w2", "Override")];

        let id = resolve_workspace_id_from_summaries(
            Some("Override"),
            &config,
            "http://server",
            &active,
            &[],
            WorkspaceLookupMode::ActiveOnly,
        )
        .unwrap();

        assert_eq!(id, "w2");
    }

    #[test]
    fn exact_id_match_wins_over_name_match() {
        let config = CliConfig::default();
        let active = vec![
            summary("w1", "ca7ba7c7-37f8-4f97-988e-a98f8e5d1e62"),
            summary("ca7ba7c7-37f8-4f97-988e-a98f8e5d1e62", "Team"),
        ];

        let id = resolve_workspace_id_from_summaries(
            Some("ca7ba7c7-37f8-4f97-988e-a98f8e5d1e62"),
            &config,
            "http://server",
            &active,
            &[],
            WorkspaceLookupMode::ActiveOnly,
        )
        .unwrap();

        assert_eq!(id, "ca7ba7c7-37f8-4f97-988e-a98f8e5d1e62");
    }

    #[test]
    fn missing_default_is_reported() {
        let config = CliConfig::default();
        let error = resolve_workspace_id_from_summaries(
            None,
            &config,
            "http://server",
            &[],
            &[],
            WorkspaceLookupMode::ActiveOnly,
        )
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::MissingResource);
    }

    #[test]
    fn ambiguous_names_fail_without_implicit_choice() {
        let config = CliConfig::default();
        let active = vec![summary("w1", "Shared"), summary("w2", "Shared")];

        let error = resolve_workspace_id_from_summaries(
            Some("Shared"),
            &config,
            "http://server",
            &active,
            &[],
            WorkspaceLookupMode::ActiveOnly,
        )
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::AmbiguousName);
    }

    #[test]
    fn archived_workspaces_require_archived_lookup_mode() {
        let config = CliConfig::default();
        let archived = vec![archived_summary("w-archived", "Old")];

        let missing = resolve_workspace_id_from_summaries(
            Some("Old"),
            &config,
            "http://server",
            &[],
            &archived,
            WorkspaceLookupMode::ActiveOnly,
        )
        .unwrap_err();
        assert_eq!(missing.kind, ErrorKind::MissingResource);

        let id = resolve_workspace_id_from_summaries(
            Some("Old"),
            &config,
            "http://server",
            &[],
            &archived,
            WorkspaceLookupMode::IncludeArchived,
        )
        .unwrap();
        assert_eq!(id, "w-archived");
    }
}
