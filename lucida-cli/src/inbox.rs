//! `lucida trace inbox`: the reports people sent, and the one you fetch.
//!
//! Somebody watching a session that will not settle presses **Send
//! report** in the monitor, and the bundle lands in their workspace's
//! inbox. This is the other end of that: `list` says what is there, and
//! `fetch` writes one to a file that `lucida trace show` reads. An agent
//! that was never in the session is then one command away from the run.
//!
//! The CLI reads over HTTP with the token it already holds, as it does
//! for workspaces and saved views. The page sends over the session
//! socket it already holds. Neither half is a second way to do the
//! other's job.
//!
//! Nothing here derives anything from a bundle. The listing prints the
//! header the sender's page wrote, field by field, and says so where a
//! field is absent; `fetch` writes the bytes the server hands back,
//! unaltered, so the file on disk is the file the page produced. The
//! reading happens in `lucida trace show`, behind the one derivation
//! every surface goes through.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::EffectiveServer;
use crate::credentials::EffectiveToken;
use crate::error::{CliError, ErrorKind};
use crate::http::{api_url, response_detail, send_json};
use crate::trace::adapter_name;
use crate::workspace::WorkspaceRecord;

/// One entry as the server lists it: who sent it, when it goes, and the
/// bundle's own header, verbatim.
///
/// `header` stays a value rather than a typed struct. The server passes
/// through what the page wrote, a bundle written by a newer or older
/// page carries what it carries, and a listing that failed to parse
/// because one field moved would be a listing that could not tell you
/// the report exists. [`InboxEntry::summary`] picks out the fields the
/// listing shows, each of them optional, and the listing says a field
/// is not in the header rather than inventing a value for it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxEntry {
    pub id: String,
    pub workspace_id: String,
    pub sent_by: String,
    pub sent_by_name: String,
    pub sent_at: String,
    pub expires_at: String,
    pub size_bytes: u64,
    #[serde(default)]
    pub header: serde_json::Value,
}

/// The fields of a bundle's header the listing prints. Every one is
/// optional, because every one is the sending page's to write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxHeaderSummary {
    pub run_id: Option<String>,
    pub cause: Option<String>,
    pub end_reason: Option<String>,
    pub duration_us: Option<u64>,
    pub dataset: Option<String>,
    pub mode: Option<String>,
    pub device_pixel_ratio: Option<String>,
    pub adapter: Option<String>,
    pub fallback_adapter: Option<bool>,
}

impl InboxEntry {
    pub fn summary(&self) -> InboxHeaderSummary {
        let header = &self.header;
        let cause = header.get("cause").and_then(|cause| {
            let epoch = text(cause.get("epoch"))?;
            match text(cause.get("source")) {
                Some(source) => Some(format!("{epoch}/{source}")),
                None => Some(epoch),
            }
        });
        let dataset = header
            .get("datasets")
            .and_then(|datasets| datasets.as_array())
            .and_then(|datasets| datasets.first())
            .and_then(|dataset| {
                text(dataset.get("sourceUrl"))
                    .or_else(|| text(dataset.get("name")))
                    .or_else(|| text(dataset.get("id")))
            });
        let gpu = header.get("gpu");
        InboxHeaderSummary {
            run_id: text(header.get("runId")),
            cause,
            end_reason: text(header.get("endReason")),
            duration_us: header.get("durationUs").and_then(serde_json::Value::as_u64),
            dataset,
            mode: text(header.get("mode")),
            device_pixel_ratio: header
                .get("devicePixelRatio")
                .filter(|ratio| !ratio.is_null())
                .map(ToString::to_string),
            adapter: gpu.and_then(|gpu| {
                adapter_name(
                    &text(gpu.get("description")).unwrap_or_default(),
                    &text(gpu.get("vendor")).unwrap_or_default(),
                    &text(gpu.get("architecture")).unwrap_or_default(),
                )
            }),
            fallback_adapter: gpu.and_then(|gpu| gpu.get("fallback")?.as_bool()),
        }
    }

    /// What a fetched bundle is called on disk: the run it holds, so the
    /// file and the `lucida trace show` that names it agree. An entry
    /// whose header carries no run falls back to the entry id, which is
    /// the only other name it has.
    pub fn filename(&self) -> String {
        let stem = self
            .summary()
            .run_id
            .filter(|run_id| is_safe_stem(run_id))
            .unwrap_or_else(|| self.id.clone());
        format!("lucida-{stem}.bundle.json")
    }
}

/// Whether a run id can be part of a file name. A run id is minted by
/// the page and normally is, but it arrived over a wire and this writes
/// a file with it.
fn is_safe_stem(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id.len() <= 64
        && run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn text(value: Option<&serde_json::Value>) -> Option<String> {
    value?.as_str().map(ToString::to_string)
}

#[derive(Debug, Serialize)]
pub struct InboxListOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub entries: Vec<InboxEntry>,
}

#[derive(Debug, Serialize)]
pub struct InboxFetchOutput {
    pub server: EffectiveServer,
    pub workspace: WorkspaceRecord,
    pub entry: InboxEntry,
    /// Where the bundle was written.
    pub path: PathBuf,
}

pub struct InboxClient {
    base_url: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl InboxClient {
    pub fn new(base_url: impl Into<String>, token: Option<EffectiveToken>) -> Self {
        Self {
            base_url: base_url.into(),
            token: token.map(|effective| effective.token),
            http: reqwest::Client::new(),
        }
    }

    /// One workspace's unexpired reports, newest first.
    pub async fn list(&self, workspace: &WorkspaceRecord) -> Result<Vec<InboxEntry>, CliError> {
        self.send(self.http.get(inbox_url(&self.base_url, &workspace.id)?))
            .await?
            .json::<Vec<InboxEntry>>()
            .await
            .map_err(CliError::from)
    }

    /// One bundle, as text. Not parsed: what gets written to disk has to
    /// be what the page produced, and `lucida trace show` is what reads
    /// it.
    pub async fn fetch(
        &self,
        workspace: &WorkspaceRecord,
        entry_id: &str,
    ) -> Result<String, CliError> {
        self.send(
            self.http
                .get(inbox_entry_url(&self.base_url, &workspace.id, entry_id)?),
        )
        .await?
        .text()
        .await
        .map_err(CliError::from)
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response, CliError> {
        send_json(request, self.token.as_deref(), map_inbox_http_error).await
    }
}

fn inbox_url(server_url: &str, workspace_id: &str) -> Result<reqwest::Url, CliError> {
    api_url(server_url, &["api", "workspaces", workspace_id, "inbox"])
}

fn inbox_entry_url(
    server_url: &str,
    workspace_id: &str,
    entry_id: &str,
) -> Result<reqwest::Url, CliError> {
    api_url(
        server_url,
        &["api", "workspaces", workspace_id, "inbox", entry_id],
    )
}

fn map_inbox_http_error(status: reqwest::StatusCode, body: &str) -> CliError {
    let detail = response_detail(body);
    match status {
        reqwest::StatusCode::UNAUTHORIZED => CliError::new(
            ErrorKind::Unauthenticated,
            "not authenticated; run `lucida auth login`",
        ),
        reqwest::StatusCode::FORBIDDEN => CliError::new(
            ErrorKind::Unauthorized,
            detail.unwrap_or_else(|| "the inbox of this workspace is for its members".to_string()),
        ),
        reqwest::StatusCode::NOT_FOUND => CliError::new(
            ErrorKind::MissingResource,
            detail.unwrap_or_else(|| {
                "no such report in this workspace's inbox; it may have expired".to_string()
            }),
        ),
        reqwest::StatusCode::GONE => CliError::new(
            ErrorKind::ArchivedWorkspace,
            detail.unwrap_or_else(|| "workspace is archived".to_string()),
        ),
        status => CliError::new(
            ErrorKind::Protocol,
            detail
                .unwrap_or_else(|| format!("unexpected inbox response: HTTP {}", status.as_u16())),
        ),
    }
}

/// Find the entry a caller named: the whole id, or enough of it to be
/// unambiguous, because an entry id is a UUID and nobody types one.
pub fn resolve_entry<'a>(
    entries: &'a [InboxEntry],
    named: &str,
) -> Result<&'a InboxEntry, CliError> {
    if let Some(exact) = entries.iter().find(|entry| entry.id == named) {
        return Ok(exact);
    }
    let matches: Vec<&InboxEntry> = entries
        .iter()
        .filter(|entry| entry.id.starts_with(named))
        .collect();
    match matches.as_slice() {
        [one] => Ok(one),
        [] => Err(CliError::new(
            ErrorKind::MissingResource,
            format!("no report in this inbox starts with {named}; run `lucida trace inbox list`"),
        )),
        several => Err(CliError::new(
            ErrorKind::AmbiguousName,
            format!(
                "{named} names {} reports: {}",
                several.len(),
                several
                    .iter()
                    .map(|entry| entry.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}

/// Where a fetched bundle goes when the caller named no path: beside the
/// runs the driver writes, so one directory holds everything `lucida
/// trace show` can read.
pub fn fetch_path(trace_dir: &Path, entry: &InboxEntry, asked_for: Option<&Path>) -> PathBuf {
    match asked_for {
        Some(path) => path.to_path_buf(),
        None => trace_dir.join(entry.filename()),
    }
}

pub fn format_inbox_list_human(output: &InboxListOutput) -> String {
    if output.entries.is_empty() {
        return format!(
            "inbox     no reports in {} ({})\n\
             \n\
             A report arrives when somebody presses Send report in the monitor. \
             Nothing is sent without that.",
            output.workspace.name, output.workspace.id,
        );
    }
    let mut lines = vec![format!(
        "inbox     {} in {} ({})",
        plural(output.entries.len(), "report"),
        output.workspace.name,
        output.workspace.id,
    )];
    for entry in &output.entries {
        lines.push(String::new());
        lines.push(entry.id.clone());
        lines.extend(entry_lines(entry));
    }
    lines.push(String::new());
    lines.push(format!(
        "next      lucida trace inbox fetch {}",
        short_id(&output.entries[0].id),
    ));
    lines.join("\n")
}

pub fn format_inbox_fetch_human(output: &InboxFetchOutput) -> String {
    let mut lines = vec![format!("bundle    {}", output.path.display())];
    lines.extend(entry_lines(&output.entry));
    lines.push(String::new());
    lines.push(format!(
        "next      lucida trace show {}",
        output.path.display()
    ));
    lines.join("\n")
}

/// The three lines that describe one entry: the run, where it ran, and
/// who sent it. Shared by the listing and the fetch so a report reads
/// the same either way.
fn entry_lines(entry: &InboxEntry) -> Vec<String> {
    let summary = entry.summary();
    let mut run = vec![summary.run_id.unwrap_or_else(|| "no run recorded".into())];
    if let Some(cause) = summary.cause {
        run.push(cause);
    }
    if let Some(end_reason) = summary.end_reason {
        run.push(match summary.duration_us {
            Some(duration_us) => format!("{end_reason} after {}", format_duration(duration_us)),
            None => end_reason,
        });
    }
    let mut where_it_ran = vec![
        summary
            .dataset
            .unwrap_or_else(|| "dataset not named in the header".into()),
    ];
    if let Some(mode) = summary.mode {
        where_it_ran.push(mode);
    }
    if let Some(ratio) = summary.device_pixel_ratio {
        where_it_ran.push(format!("DPR {ratio}"));
    }
    where_it_ran.push(match (summary.adapter, summary.fallback_adapter) {
        (Some(adapter), Some(true)) => format!("{adapter} (software fallback)"),
        (Some(adapter), _) => adapter,
        (None, _) => "adapter not named in the header".to_string(),
    });
    vec![
        format!("  run       {}", run.join(" · ")),
        format!("  ran on    {}", where_it_ran.join(" · ")),
        format!(
            "  sent      {} at {} · {} · expires {}",
            sender(entry),
            entry.sent_at,
            format_size(entry.size_bytes),
            entry.expires_at,
        ),
    ]
}

fn sender(entry: &InboxEntry) -> String {
    if entry.sent_by_name.is_empty() || entry.sent_by_name == entry.sent_by {
        entry.sent_by.clone()
    } else {
        format!("{} <{}>", entry.sent_by_name, entry.sent_by)
    }
}

/// Enough of an id to name one report in a listing that just printed
/// them all in full.
fn short_id(id: &str) -> &str {
    match id.char_indices().nth(8) {
        Some((offset, _)) => &id[..offset],
        None => id,
    }
}

fn plural(count: usize, noun: &str) -> String {
    if count == 1 {
        format!("1 {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

fn format_duration(duration_us: u64) -> String {
    let ms = duration_us as f64 / 1_000.0;
    if ms >= 1_000.0 {
        format!("{:.1} s", ms / 1_000.0)
    } else {
        format!("{ms:.0} ms")
    }
}

fn format_size(bytes: u64) -> String {
    const MB: f64 = 1_048_576.0;
    const KB: f64 = 1_024.0;
    let bytes = bytes as f64;
    if bytes >= MB {
        format!("{:.1} MB", bytes / MB)
    } else if bytes >= KB {
        format!("{:.0} kB", bytes / KB)
    } else {
        format!("{bytes:.0} bytes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ServerSource;
    use crate::workspace::WorkspaceRole;
    use serde_json::json;

    /// A listing of one workspace's inbox, with whatever entries the
    /// case is about. The server and the workspace are scenery: nothing
    /// in the formatting reads more of them than their names.
    fn listing(entries: Vec<InboxEntry>) -> InboxListOutput {
        InboxListOutput {
            server: EffectiveServer {
                url: "http://127.0.0.1:9988".to_string(),
                source: ServerSource::Default,
            },
            workspace: workspace(),
            entries,
        }
    }

    fn workspace() -> WorkspaceRecord {
        WorkspaceRecord {
            id: "ws-1".to_string(),
            name: "Field reports".to_string(),
            role: WorkspaceRole::Owner,
            created_by: "owner@example.com".to_string(),
            created_at: "2026-09-01T00:00:00Z".to_string(),
            updated_at: "2026-09-01T00:00:00Z".to_string(),
            archived_at: None,
            seq: 0,
            default_saved_view_id: None,
            last_opened_at: None,
            pinned_at: None,
        }
    }

    fn entry(id: &str, header: serde_json::Value) -> InboxEntry {
        InboxEntry {
            id: id.to_string(),
            workspace_id: "ws-1".into(),
            sent_by: "reporter@example.com".into(),
            sent_by_name: "Reporter".into(),
            sent_at: "2026-09-09T14:05:00Z".into(),
            expires_at: "2026-09-23T14:05:00Z".into(),
            size_bytes: 1_572_864,
            header,
        }
    }

    fn full_header() -> serde_json::Value {
        json!({
            "runId": "remote-cold",
            "cause": { "epoch": "view", "source": "orbit" },
            "endReason": "quiescent",
            "durationUs": 4_200_000u64,
            "datasets": [{ "id": "wds-0f3a", "name": "sample volume", "sourceUrl": "gs://set.zarr" }],
            "mode": "volume",
            "devicePixelRatio": 2,
            "gpu": { "description": "Example Adapter", "fallback": false },
        })
    }

    #[test]
    fn the_summary_reads_the_header_the_page_wrote() {
        let summary = entry("e-1", full_header()).summary();
        assert_eq!(summary.run_id.as_deref(), Some("remote-cold"));
        assert_eq!(summary.cause.as_deref(), Some("view/orbit"));
        assert_eq!(summary.end_reason.as_deref(), Some("quiescent"));
        assert_eq!(summary.duration_us, Some(4_200_000));
        assert_eq!(summary.dataset.as_deref(), Some("gs://set.zarr"));
        assert_eq!(summary.mode.as_deref(), Some("volume"));
        assert_eq!(summary.device_pixel_ratio.as_deref(), Some("2"));
        assert_eq!(summary.adapter.as_deref(), Some("Example Adapter"));
        assert_eq!(summary.fallback_adapter, Some(false));
    }

    /// A header is the sending page's to write, and a listing has to
    /// survive one that says less than this one expects.
    #[test]
    fn a_header_that_says_nothing_still_lists() {
        let listed = format_inbox_list_human(&listing(vec![entry("e-1", json!({}))]));
        assert!(listed.contains("no run recorded"), "{listed}");
        assert!(
            listed.contains("dataset not named in the header"),
            "{listed}"
        );
        assert!(
            listed.contains("adapter not named in the header"),
            "{listed}"
        );
    }

    #[test]
    fn a_listing_names_the_run_the_sender_and_the_expiry() {
        let listed = format_inbox_list_human(&listing(vec![entry("5d1f0c2e-7b3a", full_header())]));
        assert!(
            listed.contains("inbox     1 report in Field reports (ws-1)"),
            "{listed}"
        );
        assert!(
            listed.contains("remote-cold · view/orbit · quiescent after 4.2 s"),
            "{listed}"
        );
        assert!(
            listed.contains("gs://set.zarr · volume · DPR 2 · Example Adapter"),
            "{listed}"
        );
        assert!(
            listed.contains("Reporter <reporter@example.com> at 2026-09-09T14:05:00Z · 1.5 MB · expires 2026-09-23T14:05:00Z"),
            "{listed}",
        );
        // The follow-up is printed, so going deeper needs no guessing.
        assert!(
            listed.contains("next      lucida trace inbox fetch 5d1f0c2e"),
            "{listed}"
        );
    }

    #[test]
    fn a_software_fallback_adapter_is_called_one() {
        let mut header = full_header();
        header["gpu"]["fallback"] = json!(true);
        let listed = format_inbox_list_human(&listing(vec![entry("e-1", header)]));
        assert!(
            listed.contains("Example Adapter (software fallback)"),
            "{listed}"
        );
    }

    /// The browser gives most adapters an empty description, so the
    /// vendor and architecture are the usual name, by the same rule
    /// `lucida trace show` names an adapter with.
    #[test]
    fn an_adapter_without_a_description_is_named_by_vendor_and_architecture() {
        let mut header = full_header();
        header["gpu"] = json!({
            "vendor": "nvidia",
            "architecture": "lovelace",
            "device": "",
            "description": "",
            "fallback": false,
            "timestampQueries": true,
        });
        let summary = entry("e-1", header.clone()).summary();
        assert_eq!(summary.adapter.as_deref(), Some("nvidia lovelace"));
        assert_eq!(summary.fallback_adapter, Some(false));

        let listed = format_inbox_list_human(&listing(vec![entry("e-1", header.clone())]));
        assert!(listed.contains("DPR 2 · nvidia lovelace"), "{listed}");
        assert!(!listed.contains("adapter not named"), "{listed}");

        header["gpu"]["fallback"] = json!(true);
        let listed = format_inbox_list_human(&listing(vec![entry("e-1", header)]));
        assert!(
            listed.contains("nvidia lovelace (software fallback)"),
            "{listed}"
        );
    }

    /// A `gpu` object that names nothing at all still reads as unnamed
    /// rather than as a blank.
    #[test]
    fn an_adapter_that_names_nothing_is_still_unnamed() {
        let mut header = full_header();
        header["gpu"] = json!({ "vendor": "", "architecture": "", "description": "  " });
        let summary = entry("e-1", header).summary();
        assert_eq!(summary.adapter, None);
    }

    #[test]
    fn an_empty_inbox_says_what_puts_a_report_in_one() {
        let listed = format_inbox_list_human(&listing(vec![]));
        assert!(listed.contains("no reports in Field reports"), "{listed}");
        assert!(listed.contains("Send report"), "{listed}");
    }

    #[test]
    fn a_fetch_names_the_file_and_the_command_that_reads_it() {
        let output = InboxFetchOutput {
            server: listing(vec![]).server,
            workspace: workspace(),
            entry: entry("e-1", full_header()),
            path: PathBuf::from("/traces/lucida-remote-cold.bundle.json"),
        };
        let text = format_inbox_fetch_human(&output);
        assert!(
            text.contains("bundle    /traces/lucida-remote-cold.bundle.json"),
            "{text}"
        );
        assert!(
            text.contains("next      lucida trace show /traces/lucida-remote-cold.bundle.json"),
            "{text}",
        );
    }

    /// The file is named for the run, so the file and the follow-up
    /// command that names that run agree.
    #[test]
    fn a_fetched_bundle_is_named_for_its_run() {
        assert_eq!(
            fetch_path(Path::new("/traces"), &entry("e-1", full_header()), None),
            PathBuf::from("/traces/lucida-remote-cold.bundle.json"),
        );
    }

    /// A run id arrived over a wire, and this writes a file with it.
    #[test]
    fn a_run_id_that_could_not_be_a_file_name_falls_back_to_the_entry_id() {
        for run_id in ["../../etc/passwd", "with space", ""] {
            let entry = entry("e-1", json!({ "runId": run_id }));
            assert_eq!(
                fetch_path(Path::new("/traces"), &entry, None),
                PathBuf::from("/traces/lucida-e-1.bundle.json"),
                "a run id of {run_id:?} should not name the file",
            );
        }
    }

    #[test]
    fn an_explicit_output_path_wins() {
        assert_eq!(
            fetch_path(
                Path::new("/traces"),
                &entry("e-1", full_header()),
                Some(Path::new("/tmp/report.json")),
            ),
            PathBuf::from("/tmp/report.json"),
        );
    }

    /// The end of the path a field report takes: what a fetch writes,
    /// `lucida trace show` reads.
    ///
    /// The bytes are the golden bundle the web suite writes, which is
    /// what a real fetch hands over — the server stores what the page
    /// produced and this command writes it out unaltered. The file is
    /// then read back through the reader `show` uses.
    #[test]
    fn a_fetched_bundle_is_a_file_the_show_command_reads() {
        let golden = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("trace-fixtures")
            .join("bundle-v1.json");
        let bundle = std::fs::read_to_string(&golden).unwrap();
        let header: serde_json::Value = serde_json::from_str(&bundle).unwrap();

        let entry = entry("5d1f0c2e-7b3a", header["header"].clone());
        let dir = std::env::temp_dir().join(format!("lucida-inbox-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = fetch_path(&dir, &entry, None);
        std::fs::write(&path, &bundle).unwrap();

        assert_eq!(path, dir.join("lucida-local-healthy.bundle.json"));
        let artifact = crate::trace::read_artifact(&path).unwrap();
        let crate::trace::TraceArtifact::Bundle(read) = artifact else {
            panic!("the fetched file did not read as a bundle");
        };
        assert_eq!(read.header.run_id.as_deref(), Some("local-healthy"));
        // And the command the fetch prints resolves to the file it wrote,
        // rather than to a run id under the trace directory.
        assert_eq!(
            crate::trace::resolve_run_file(&dir, path.to_str().unwrap()),
            path
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_entry_resolves_by_its_whole_id_or_by_enough_of_it() {
        let entries = vec![
            entry("5d1f0c2e-7b3a", full_header()),
            entry("5d1f0c2e-9999", full_header()),
            entry("aa11", full_header()),
        ];
        assert_eq!(
            resolve_entry(&entries, "5d1f0c2e-7b3a").unwrap().id,
            "5d1f0c2e-7b3a"
        );
        assert_eq!(resolve_entry(&entries, "aa").unwrap().id, "aa11");
        assert_eq!(
            resolve_entry(&entries, "5d1f").unwrap_err().kind,
            ErrorKind::AmbiguousName
        );
        assert_eq!(
            resolve_entry(&entries, "nothing").unwrap_err().kind,
            ErrorKind::MissingResource
        );
    }
}
