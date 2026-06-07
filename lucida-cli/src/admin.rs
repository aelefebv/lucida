use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::config::EffectiveServer;
use crate::credentials::EffectiveToken;
use crate::error::{CliError, ErrorKind};
use crate::workspace::WorkspaceRole;

pub const REMOTE_ADMIN_SCOPE: &str = "remote_admin";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceLinkAccess {
    Restricted,
    AnyoneWithLink,
}

impl WorkspaceLinkAccess {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Restricted => "restricted",
            Self::AnyoneWithLink => "anyone_with_link",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceAdminSummary {
    pub id: String,
    pub name: String,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
    pub seq: u64,
    pub dataset_count: i64,
    pub member_count: i64,
    pub owner_count: i64,
    pub link_access: WorkspaceLinkAccess,
    pub link_role: WorkspaceRole,
    pub default_saved_view_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceMember {
    pub email: String,
    pub role: WorkspaceRole,
    pub display_name: String,
    pub added_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceAdminDetails {
    pub workspace: WorkspaceAdminSummary,
    pub members: Vec<WorkspaceMember>,
}

#[derive(Debug, Serialize)]
pub struct AdminWorkspaceSearchOutput {
    pub scope: &'static str,
    pub server: EffectiveServer,
    pub query: Option<String>,
    pub include_archived: bool,
    pub limit: usize,
    pub workspaces: Vec<WorkspaceAdminSummary>,
}

#[derive(Debug, Serialize)]
pub struct AdminWorkspaceDetailsOutput {
    pub scope: &'static str,
    pub server: EffectiveServer,
    pub workspace: WorkspaceAdminSummary,
    pub members: Vec<WorkspaceMember>,
}

#[derive(Debug, Serialize)]
pub struct AdminWorkspaceOwnerOutput {
    pub scope: &'static str,
    pub server: EffectiveServer,
    pub workspace_id: String,
    pub member: WorkspaceMember,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdminClearProxyCacheResult {
    pub cleared: bool,
    pub datasets: usize,
    pub files: usize,
}

#[derive(Debug, Serialize)]
pub struct AdminClearProxyCacheOutput {
    pub scope: &'static str,
    pub server: EffectiveServer,
    pub dataset: Option<String>,
    pub cleared: bool,
    pub datasets: usize,
    pub files: usize,
}

pub struct AdminClient {
    base_url: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl AdminClient {
    pub fn new(base_url: impl Into<String>, token: Option<EffectiveToken>) -> Self {
        Self {
            base_url: base_url.into(),
            token: token.map(|effective| effective.token),
            http: reqwest::Client::new(),
        }
    }

    pub async fn search_workspaces(
        &self,
        query: Option<&str>,
        include_archived: bool,
        limit: usize,
    ) -> Result<Vec<WorkspaceAdminSummary>, CliError> {
        self.send_json(
            self.search_workspaces_request(query, include_archived, limit)?,
            "admin workspace search",
        )
        .await
    }

    pub async fn workspace_info(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceAdminDetails, CliError> {
        self.send_json(
            self.http.get(admin_url(
                &self.base_url,
                &["admin", "workspaces", workspace_id],
            )?),
            "admin workspace info",
        )
        .await
    }

    pub async fn archive_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceAdminDetails, CliError> {
        self.send_json(
            self.http.post(admin_url(
                &self.base_url,
                &["admin", "workspaces", workspace_id, "archive"],
            )?),
            "admin workspace archive",
        )
        .await
    }

    pub async fn restore_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceAdminDetails, CliError> {
        self.send_json(
            self.http.post(admin_url(
                &self.base_url,
                &["admin", "workspaces", workspace_id, "restore"],
            )?),
            "admin workspace restore",
        )
        .await
    }

    pub async fn add_or_promote_owner(
        &self,
        workspace_id: &str,
        email: &str,
        display_name: Option<&str>,
    ) -> Result<WorkspaceMember, CliError> {
        self.send_json(
            self.owner_update_request(workspace_id, email, display_name)?,
            "admin workspace owner update",
        )
        .await
    }

    pub async fn clear_proxy_cache(
        &self,
        dataset: Option<&str>,
    ) -> Result<AdminClearProxyCacheResult, CliError> {
        self.send_json(
            self.clear_proxy_cache_request(dataset)?,
            "admin clear-proxy-cache",
        )
        .await
    }

    fn search_workspaces_request(
        &self,
        query: Option<&str>,
        include_archived: bool,
        limit: usize,
    ) -> Result<reqwest::RequestBuilder, CliError> {
        let mut url = admin_url(&self.base_url, &["admin", "workspaces"])?;
        {
            let mut pairs = url.query_pairs_mut();
            if let Some(query) = query.map(str::trim).filter(|query| !query.is_empty()) {
                pairs.append_pair("q", query);
            }
            pairs.append_pair(
                "include_archived",
                if include_archived { "true" } else { "false" },
            );
            pairs.append_pair("limit", &limit.to_string());
        }
        Ok(self.http.get(url))
    }

    fn owner_update_request(
        &self,
        workspace_id: &str,
        email: &str,
        display_name: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, CliError> {
        let body = serde_json::json!({
            "email": email,
            "display_name": display_name,
        });
        Ok(self
            .http
            .post(admin_url(
                &self.base_url,
                &["admin", "workspaces", workspace_id, "owners"],
            )?)
            .json(&body))
    }

    fn clear_proxy_cache_request(
        &self,
        dataset: Option<&str>,
    ) -> Result<reqwest::RequestBuilder, CliError> {
        let mut url = admin_url(&self.base_url, &["admin", "clear-proxy-cache"])?;
        if let Some(dataset) = dataset {
            url.query_pairs_mut().append_pair("dataset", dataset);
        }
        Ok(self.http.post(url))
    }

    async fn send_json<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
        action: &'static str,
    ) -> Result<T, CliError> {
        let request = self.prepare(request);
        let response = request.send().await?;
        let status = response.status();
        if status.is_success() {
            return response.json::<T>().await.map_err(|error| {
                CliError::new(
                    ErrorKind::Protocol,
                    format!("{action} returned invalid JSON: {error}"),
                )
            });
        }

        let body = response.text().await.unwrap_or_default();
        Err(map_admin_error(status, &body, action))
    }

    fn prepare(&self, mut request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(token) = self.token.as_deref() {
            request = request.bearer_auth(token);
        }
        request.header(reqwest::header::ACCEPT, "application/json")
    }
}

fn admin_url(server_url: &str, segments: &[&str]) -> Result<reqwest::Url, CliError> {
    let mut url = reqwest::Url::parse(server_url)
        .map_err(|error| CliError::invalid_server(format!("invalid server URL: {error}")))?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| CliError::invalid_server("server URL cannot be used as a base URL"))?;
        path.clear();
        for segment in segments {
            path.push(segment);
        }
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    error: Option<String>,
    detail: Option<String>,
}

fn map_admin_error(status: reqwest::StatusCode, body: &str, action: &'static str) -> CliError {
    let detail = admin_error_detail(body);
    match status {
        reqwest::StatusCode::UNAUTHORIZED => CliError::new(
            ErrorKind::Unauthenticated,
            "not authenticated; run `lucida auth login`",
        ),
        reqwest::StatusCode::FORBIDDEN => CliError::new(
            ErrorKind::Unauthorized,
            detail.unwrap_or_else(|| format!("{action} requires a Lucida admin principal")),
        ),
        reqwest::StatusCode::NOT_FOUND => CliError::new(
            ErrorKind::MissingResource,
            detail.unwrap_or_else(|| format!("{action} target was not found")),
        ),
        reqwest::StatusCode::GONE => CliError::new(
            ErrorKind::ArchivedWorkspace,
            detail.unwrap_or_else(|| format!("{action} target is archived")),
        ),
        reqwest::StatusCode::BAD_REQUEST => CliError::new(
            ErrorKind::Config,
            detail.unwrap_or_else(|| format!("{action} request was invalid")),
        ),
        status => CliError::new(
            ErrorKind::Protocol,
            detail.unwrap_or_else(|| {
                format!("unexpected {action} response: HTTP {}", status.as_u16())
            }),
        ),
    }
}

fn admin_error_detail(body: &str) -> Option<String> {
    let body = body.trim();
    if body.is_empty() {
        return None;
    }
    if let Ok(error) = serde_json::from_str::<ErrorBody>(body) {
        if let Some(detail) = error.detail.filter(|detail| !detail.trim().is_empty()) {
            return Some(detail);
        }
        if let Some(code) = error.error.filter(|code| !code.trim().is_empty()) {
            return Some(code);
        }
    }
    Some(body.to_string())
}

pub fn format_admin_workspace_search_human(output: &AdminWorkspaceSearchOutput) -> String {
    if output.workspaces.is_empty() {
        return "Remote admin workspace search: no workspaces found".to_string();
    }

    let mut lines = vec![format!(
        "Remote admin workspace search: {} result{}",
        output.workspaces.len(),
        plural(output.workspaces.len())
    )];
    for workspace in &output.workspaces {
        lines.push(format!(
            "{}  {}  ({}, {} member{}, {} owner{}, {} dataset{}, link {}/{})",
            workspace.id,
            workspace.name,
            workspace_state(workspace),
            workspace.member_count,
            plural_i64(workspace.member_count),
            workspace.owner_count,
            plural_i64(workspace.owner_count),
            workspace.dataset_count,
            plural_i64(workspace.dataset_count),
            workspace.link_access.as_str(),
            workspace.link_role.as_str(),
        ));
    }
    lines.join("\n")
}

pub fn format_admin_workspace_details_human(
    output: &AdminWorkspaceDetailsOutput,
    action: &str,
) -> String {
    let workspace = &output.workspace;
    let archived = workspace.archived_at.as_deref().unwrap_or("no");
    let mut lines = vec![
        format!("Remote admin workspace {action}"),
        format!("Workspace: {}", workspace.name),
        format!("ID: {}", workspace.id),
        format!("State: {}", workspace_state(workspace)),
        format!("Created by: {}", workspace.created_by),
        format!("Updated: {}", workspace.updated_at),
        format!("Archived: {archived}"),
        format!(
            "Counts: {} member{}, {} owner{}, {} dataset{}",
            workspace.member_count,
            plural_i64(workspace.member_count),
            workspace.owner_count,
            plural_i64(workspace.owner_count),
            workspace.dataset_count,
            plural_i64(workspace.dataset_count),
        ),
        format!(
            "Link: {}/{}",
            workspace.link_access.as_str(),
            workspace.link_role.as_str()
        ),
    ];
    if output.members.is_empty() {
        lines.push("Members: none".to_string());
    } else {
        lines.push("Members:".to_string());
        for member in &output.members {
            let display = if member.display_name.trim().is_empty() {
                "".to_string()
            } else {
                format!(" ({})", member.display_name)
            };
            lines.push(format!(
                "- {}{}: {}",
                member.email,
                display,
                member.role.as_str()
            ));
        }
    }
    lines.join("\n")
}

pub fn format_admin_workspace_owner_human(output: &AdminWorkspaceOwnerOutput) -> String {
    let display = if output.member.display_name.trim().is_empty() {
        "".to_string()
    } else {
        format!(" ({})", output.member.display_name)
    };
    format!(
        "Remote admin workspace owner updated\nWorkspace: {}\nOwner: {}{}\nRole: {}",
        output.workspace_id,
        output.member.email,
        display,
        output.member.role.as_str()
    )
}

pub fn format_admin_clear_proxy_cache_human(output: &AdminClearProxyCacheOutput) -> String {
    format!(
        "Remote admin clear-proxy-cache\nDataset: {}\nCleared: {}\nDatasets: {}\nFiles: {}",
        output.dataset.as_deref().unwrap_or("<all>"),
        output.cleared,
        output.datasets,
        output.files
    )
}

fn workspace_state(workspace: &WorkspaceAdminSummary) -> &'static str {
    if workspace.archived_at.is_some() {
        "archived"
    } else {
        "active"
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

fn plural_i64(count: i64) -> &'static str {
    if count == 1 { "" } else { "s" }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::TokenSource;

    #[test]
    fn search_constructs_request_and_parses_success_body() {
        let client = admin_client("admin-token");
        let request = client
            .prepare(
                client
                    .search_workspaces_request(Some("Alpha"), true, 7)
                    .unwrap(),
            )
            .build()
            .unwrap();

        assert_eq!(request.method(), reqwest::Method::GET);
        assert_eq!(request.url().path(), "/admin/workspaces");
        assert_eq!(
            request.url().query(),
            Some("q=Alpha&include_archived=true&limit=7")
        );
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .unwrap(),
            "Bearer admin-token"
        );
        assert_eq!(
            request.headers().get(reqwest::header::ACCEPT).unwrap(),
            "application/json"
        );

        let body = serde_json::json!([sample_workspace("w1", "Alpha")]).to_string();
        let workspaces: Vec<WorkspaceAdminSummary> = serde_json::from_str(&body).unwrap();

        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].id, "w1");
    }

    #[test]
    fn owner_update_posts_json_and_parses_member_body() {
        let client = admin_client("admin-token");
        let request = client
            .prepare(
                client
                    .owner_update_request("w1", "owner@example.com", Some("Owner"))
                    .unwrap(),
            )
            .build()
            .unwrap();

        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(request.url().path(), "/admin/workspaces/w1/owners");
        assert_eq!(
            request
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .unwrap(),
            "Bearer admin-token"
        );
        let body = request.body().and_then(|body| body.as_bytes()).unwrap();
        let body = std::str::from_utf8(body).unwrap();
        assert!(body.contains("\"email\":\"owner@example.com\""));
        assert!(body.contains("\"display_name\":\"Owner\""));

        let body = serde_json::json!(sample_member("owner@example.com", "Owner")).to_string();
        let member: WorkspaceMember = serde_json::from_str(&body).unwrap();

        assert_eq!(member.email, "owner@example.com");
        assert_eq!(member.role, WorkspaceRole::Owner);
    }

    #[test]
    fn non_admin_failure_maps_to_structured_unauthorized_error() {
        let error = map_admin_error(
            reqwest::StatusCode::FORBIDDEN,
            r#"{"error":"forbidden"}"#,
            "admin workspace search",
        );

        assert_eq!(error.kind, ErrorKind::Unauthorized);
        assert_eq!(error.to_json()["error"]["kind"], "unauthorized");
        assert_eq!(error.message, "forbidden");
    }

    #[test]
    fn clear_proxy_cache_posts_remote_admin_route() {
        let client = AdminClient::new("http://127.0.0.1:9988", None);
        let request = client
            .prepare(
                client
                    .clear_proxy_cache_request(Some("file:///data/demo.ome.zarr"))
                    .unwrap(),
            )
            .build()
            .unwrap();

        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(request.url().path(), "/admin/clear-proxy-cache");
        assert_eq!(
            request.url().query(),
            Some("dataset=file%3A%2F%2F%2Fdata%2Fdemo.ome.zarr")
        );
        assert!(
            request
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .is_none()
        );

        let body = serde_json::json!({
            "cleared": true,
            "datasets": 1,
            "files": 3
        })
        .to_string();
        let result: AdminClearProxyCacheResult = serde_json::from_str(&body).unwrap();

        assert_eq!(
            result,
            AdminClearProxyCacheResult {
                cleared: true,
                datasets: 1,
                files: 3
            }
        );
    }

    #[test]
    fn human_output_labels_remote_admin_scope() {
        let output = AdminWorkspaceSearchOutput {
            scope: REMOTE_ADMIN_SCOPE,
            server: EffectiveServer {
                url: "http://127.0.0.1:9988".to_string(),
                source: crate::config::ServerSource::Flag,
            },
            query: Some("Alpha".to_string()),
            include_archived: true,
            limit: 25,
            workspaces: vec![sample_workspace("w1", "Alpha")],
        };

        let human = format_admin_workspace_search_human(&output);

        assert!(human.contains("Remote admin workspace search"));
        assert!(human.contains("w1  Alpha"));
    }

    fn admin_client(token: &str) -> AdminClient {
        AdminClient::new(
            "http://127.0.0.1:9988",
            Some(EffectiveToken {
                token: token.to_string(),
                source: TokenSource::Config,
            }),
        )
    }

    fn sample_workspace(id: &str, name: &str) -> WorkspaceAdminSummary {
        WorkspaceAdminSummary {
            id: id.to_string(),
            name: name.to_string(),
            created_by: "owner@example.com".to_string(),
            created_at: "2026-06-07T00:00:00Z".to_string(),
            updated_at: "2026-06-07T00:00:00Z".to_string(),
            archived_at: None,
            seq: 2,
            dataset_count: 1,
            member_count: 2,
            owner_count: 1,
            link_access: WorkspaceLinkAccess::Restricted,
            link_role: WorkspaceRole::Viewer,
            default_saved_view_id: None,
        }
    }

    fn sample_member(email: &str, display_name: &str) -> WorkspaceMember {
        WorkspaceMember {
            email: email.to_string(),
            role: WorkspaceRole::Owner,
            display_name: display_name.to_string(),
            added_at: "2026-06-07T00:00:00Z".to_string(),
        }
    }
}
