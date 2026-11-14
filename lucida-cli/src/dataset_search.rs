//! `lucida dataset search`: the datasets the server lists, found by words
//! and narrowed by owner, kind and date, as the Open dialog finds them.
//!
//! One call fetches one page. Its `next_cursor`, passed back with
//! `--cursor` and the same words and flags, fetches the page after.

use chrono::{DateTime, NaiveDate, NaiveTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::credentials::EffectiveToken;
use crate::error::{CliError, ErrorKind};
use crate::http::{api_url, response_detail, send_json};

/// The words and flags `lucida dataset search` takes.
#[derive(clap::Args, Debug, Clone)]
pub struct DatasetSearchArgs {
    /// Words every result contains, ignoring case, in its title, its
    /// group, the end of its URL, or a field. Omit to list every dataset.
    words: Vec<String>,
    /// Fetch the page after the one that returned this `next_cursor`.
    /// Pass the same words and flags.
    #[arg(long)]
    cursor: Option<String>,
    /// Only the datasets you own. Without --mine or --everyone, the server
    /// chooses.
    #[arg(long, conflicts_with = "everyone")]
    mine: bool,
    /// Every owner's datasets.
    #[arg(long)]
    everyone: bool,
    /// Only datasets of this kind.
    #[arg(long, value_enum)]
    kind: Option<ListingKind>,
    /// Only datasets dated at or after this RFC 3339 time, or this date
    /// (such as 2026-11-05) from midnight UTC. Undated datasets never match.
    #[arg(long, value_name = "TIME", value_parser = parse_since)]
    since: Option<DateTime<Utc>>,
}

impl DatasetSearchArgs {
    pub fn request(&self) -> SearchRequest {
        SearchRequest {
            words: self.words.join(" "),
            cursor: self.cursor.clone(),
            scope: if self.mine {
                Some(Scope::Mine)
            } else if self.everyone {
                Some(Scope::Everyone)
            } else {
                None
            },
            kind: self.kind,
            since: self.since,
        }
    }
}

/// One search, written as the query `GET /api/listings` takes. A field
/// left empty leaves that parameter out, so the server's default applies.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SearchRequest {
    /// Space-separated. With none, every listing matches.
    #[serde(rename = "q", skip_serializing_if = "String::is_empty")]
    pub words: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<Scope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ListingKind>,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_since"
    )]
    pub since: Option<DateTime<Utc>>,
}

/// Whose listings a search keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Mine,
    Everyone,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mine => "mine",
            Self::Everyone => "everyone",
        }
    }
}

/// The kinds a search can narrow to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum ListingKind {
    Image,
    Collection,
}

impl ListingKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Collection => "collection",
        }
    }
}

const SINCE_FORMS: &str =
    "expected an RFC 3339 time, such as 2026-11-05T09:30:00Z, or a date, such as 2026-11-05";

/// Reads `--since`. A plain date starts at midnight UTC, so the bound is the
/// same wherever the command runs.
pub fn parse_since(text: &str) -> Result<DateTime<Utc>, String> {
    if let Ok(at) = DateTime::parse_from_rfc3339(text) {
        return Ok(at.with_timezone(&Utc));
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .map(|date| date.and_time(NaiveTime::MIN).and_utc())
        .map_err(|_| SINCE_FORMS.to_string())
}

fn rfc3339(at: &DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

fn serialize_since<S: serde::Serializer>(
    since: &Option<DateTime<Utc>>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match since {
        Some(at) => serializer.serialize_str(&rfc3339(at)),
        None => serializer.serialize_none(),
    }
}

/// One page of search results.
#[derive(Debug)]
pub struct ListingSearch {
    /// The response as the server sent it. `--json` prints this rather
    /// than [`ListingSearch::page`], so a field this client doesn't read
    /// still reaches a script.
    pub body: String,
    pub page: ListingPage,
}

/// The parts of a search response the human output shows. Fields it
/// doesn't name are ignored, so the server can add some.
#[derive(Debug, Deserialize)]
pub struct ListingPage {
    /// In the server's order, which the output keeps.
    pub results: Vec<ListingResult>,
    pub next_cursor: Option<String>,
    /// Whose listings the results hold, which is everyone's when `mine`
    /// was asked of a server that can't tell owners apart. Absent from a
    /// server that doesn't scope.
    #[serde(default)]
    pub scope: Option<String>,
    /// Matches the scope left out, over every page.
    #[serde(default)]
    pub outside_scope: u64,
}

/// One group's matching listings, or one listing that has no group.
#[derive(Debug, Deserialize)]
pub struct ListingResult {
    pub group: Option<ListingGroup>,
    pub listings: Vec<Listing>,
}

#[derive(Debug, Deserialize)]
pub struct ListingGroup {
    pub label: String,
    /// What the listing's source calls a group, such as "Folder".
    pub noun: String,
}

#[derive(Debug, Deserialize)]
pub struct Listing {
    pub url: String,
    pub title: String,
    /// Kept as text, so a kind this client doesn't know still prints.
    pub kind: String,
    /// RFC 3339.
    pub date: Option<String>,
    /// How many tiles a collection holds.
    pub tiles: Option<u64>,
    #[serde(default)]
    pub fields: Vec<ListingField>,
}

#[derive(Debug, Deserialize)]
pub struct ListingField {
    pub name: String,
    pub value: String,
}

pub struct DatasetSearchClient {
    base_url: String,
    token: Option<String>,
    http: reqwest::Client,
}

impl DatasetSearchClient {
    pub fn new(base_url: impl Into<String>, token: Option<EffectiveToken>) -> Self {
        Self {
            base_url: base_url.into(),
            token: token.map(|effective| effective.token),
            http: reqwest::Client::new(),
        }
    }

    /// The page of listings `search` finds.
    pub async fn search(&self, search: &SearchRequest) -> Result<ListingSearch, CliError> {
        let request = self
            .http
            .get(api_url(&self.base_url, &["api", "listings"])?)
            .query(search);
        let body = send_json(request, self.token.as_deref(), map_search_error)
            .await?
            .text()
            .await?;
        let page = serde_json::from_str(&body).map_err(|error| {
            CliError::new(
                ErrorKind::Protocol,
                format!("unexpected search response: {error}"),
            )
        })?;
        Ok(ListingSearch { body, page })
    }
}

fn map_search_error(status: reqwest::StatusCode, body: &str) -> CliError {
    let detail = response_detail(body);
    match status {
        reqwest::StatusCode::UNAUTHORIZED => CliError::new(
            ErrorKind::Unauthenticated,
            "not authenticated; run `lucida auth login`",
        ),
        reqwest::StatusCode::FORBIDDEN => CliError::new(
            ErrorKind::Unauthorized,
            detail.unwrap_or_else(|| "search was forbidden".to_string()),
        ),
        reqwest::StatusCode::BAD_REQUEST => CliError::new(
            ErrorKind::Config,
            detail.unwrap_or_else(|| "search request was invalid".to_string()),
        ),
        status => CliError::new(
            ErrorKind::Protocol,
            detail
                .unwrap_or_else(|| format!("unexpected search response: HTTP {}", status.as_u16())),
        ),
    }
}

/// Each result in the server's order: a group's noun and label above its
/// listings, or a listing that has no group on its own. The last line
/// counts the matches the scope left out, as the Open dialog's
/// "more in everyone's" row does.
pub fn format_dataset_search_human(page: &ListingPage, search: &SearchRequest) -> String {
    let mut blocks = Vec::new();
    // Results that look like yours but aren't would mislead, so say when
    // the server answered for everyone instead.
    if search.scope == Some(Scope::Mine) && page.scope.as_deref() != Some(Scope::Mine.as_str()) {
        blocks.push("Everyone's datasets: the server doesn't know which are yours".to_string());
    }
    if page.results.is_empty() {
        blocks.push(if page.outside_scope > 0 {
            "None of the matches are yours".to_string()
        } else {
            nothing_found(search)
        });
    }
    blocks.extend(page.results.iter().map(format_result));
    if let Some(cursor) = &page.next_cursor {
        blocks.push(format!(
            "More results: run the same search again with --cursor {cursor}"
        ));
    }
    if page.outside_scope > 0 {
        let more = if page.results.is_empty() { "" } else { " more" };
        blocks.push(format!(
            "{}{more} in everyone's: run again with --everyone",
            page.outside_scope
        ));
    }
    blocks.join("\n\n")
}

/// Names the kind and date, since either can be what left nothing.
fn nothing_found(search: &SearchRequest) -> String {
    let noun = search.kind.map_or("dataset", ListingKind::as_str);
    let dated = search
        .since
        .map(|at| format!(" dated at or after {}", rfc3339(&at)))
        .unwrap_or_default();
    if search.words.is_empty() {
        format!("The server lists no {noun}s{dated}")
    } else {
        format!("No listed {noun}{dated} matches \"{}\"", search.words)
    }
}

fn format_result(result: &ListingResult) -> String {
    let listings = result.listings.iter().map(format_listing);
    match &result.group {
        Some(group) => std::iter::once(format!("{}: {}", group.noun, group.label))
            .chain(listings.flat_map(|lines| lines.into_iter().map(|line| format!("  {line}"))))
            .collect::<Vec<_>>()
            .join("\n"),
        None => listings.flatten().collect::<Vec<_>>().join("\n"),
    }
}

/// The title with what the Open dialog shows beside it, then the URL.
fn format_listing(listing: &Listing) -> Vec<String> {
    let mut tags = vec![listing.kind.clone()];
    if let Some(tiles) = listing.tiles {
        tags.push(if tiles == 1 {
            "1 tile".to_string()
        } else {
            format!("{tiles} tiles")
        });
    }
    tags.extend(
        listing
            .fields
            .iter()
            .map(|field| format!("{}: {}", field.name, field.value)),
    );
    if let Some(date) = &listing.date {
        tags.push(calendar_date(date).to_string());
    }
    vec![
        format!("{}  ({})", listing.title, tags.join(", ")),
        format!("  {}", listing.url),
    ]
}

/// The calendar date an RFC 3339 timestamp starts with, which is as much
/// as a person scanning results reads. `--json` keeps the whole timestamp.
fn calendar_date(timestamp: &str) -> &str {
    timestamp.get(..10).unwrap_or(timestamp)
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    fn page(json: &str) -> ListingPage {
        serde_json::from_str(json).expect("a search response")
    }

    fn words(words: &str) -> SearchRequest {
        SearchRequest {
            words: words.to_string(),
            ..SearchRequest::default()
        }
    }

    #[derive(clap::Parser)]
    struct Search {
        #[command(flatten)]
        args: DatasetSearchArgs,
    }

    fn try_flags(flags: &[&str]) -> Result<SearchRequest, clap::Error> {
        let argv = std::iter::once("search").chain(flags.iter().copied());
        <Search as clap::Parser>::try_parse_from(argv).map(|search| search.args.request())
    }

    fn flags(flags: &[&str]) -> SearchRequest {
        try_flags(flags).expect("valid flags")
    }

    #[test]
    fn since_takes_an_rfc_3339_time_or_a_date_from_midnight_utc() {
        assert_eq!(
            rfc3339(&parse_since("2026-11-05").unwrap()),
            "2026-11-05T00:00:00Z"
        );
        assert_eq!(
            rfc3339(&parse_since("2026-11-05T09:30:00.25+02:00").unwrap()),
            "2026-11-05T07:30:00.250Z"
        );
        for malformed in [
            "last week",
            "2026-11-05T09:30:00",
            "2026-13-01",
            "05/11/2026",
            "",
        ] {
            assert_eq!(
                parse_since(malformed),
                Err(SINCE_FORMS.to_string()),
                "{malformed}"
            );
        }
    }

    #[test]
    fn mine_and_everyone_together_are_refused() {
        let error = try_flags(&["--mine", "--everyone"]).expect_err("two scopes");
        assert_eq!(error.kind(), clap::error::ErrorKind::ArgumentConflict);
    }

    /// Clap reads the bound while parsing, so a malformed one never reaches
    /// a request.
    #[test]
    fn a_malformed_since_is_refused_with_the_forms_it_takes() {
        let error = try_flags(&["--since", "last week"]).expect_err("a malformed date");
        assert_eq!(error.kind(), clap::error::ErrorKind::ValueValidation);
        assert!(error.to_string().contains(SINCE_FORMS), "{error}");
    }

    #[test]
    fn listings_print_under_their_group_in_the_servers_order() {
        let page = page(
            r#"{
              "results": [
                {
                  "group": { "id": "/srv/data/runs", "label": "runs", "noun": "Folder" },
                  "collapsed": false,
                  "listings": [
                    { "url": "/srv/data/runs/b.zarr", "title": "b.zarr", "kind": "image",
                      "owner": null, "date": "2026-11-06T00:57:34.461656800Z", "tiles": null,
                      "fields": [] },
                    { "url": "/srv/data/runs/a.zarr", "title": "a.zarr", "kind": "collection",
                      "owner": null, "date": "2026-11-05T10:00:00Z", "tiles": 12,
                      "fields": [{ "name": "label", "value": "first" }] }
                  ]
                },
                {
                  "group": null,
                  "collapsed": false,
                  "listings": [
                    { "url": "gs://bucket/c.zarr", "title": "c.zarr", "kind": "collection",
                      "owner": null, "date": null, "tiles": 1, "fields": [] }
                  ]
                }
              ],
              "next_cursor": "eyJuIjoxfQ"
            }"#,
        );

        assert_eq!(
            format_dataset_search_human(&page, &words("runs")),
            "Folder: runs\n\
             \x20 b.zarr  (image, 2026-11-06)\n\
             \x20   /srv/data/runs/b.zarr\n\
             \x20 a.zarr  (collection, 12 tiles, label: first, 2026-11-05)\n\
             \x20   /srv/data/runs/a.zarr\n\
             \n\
             c.zarr  (collection, 1 tile)\n\
             \x20 gs://bucket/c.zarr\n\
             \n\
             More results: run the same search again with --cursor eyJuIjoxfQ"
        );
    }

    #[test]
    fn an_empty_page_names_what_narrowed_it() {
        let empty = page(r#"{ "results": [], "next_cursor": null }"#);
        let cases = [
            (&[][..], "The server lists no datasets"),
            (&["two", "words"], "No listed dataset matches \"two words\""),
            (&["--kind", "collection"], "The server lists no collections"),
            (
                &["--kind", "image", "--since", "2026-11-05"],
                "The server lists no images dated at or after 2026-11-05T00:00:00Z",
            ),
            (
                &["grid", "--since", "2026-11-05"],
                "No listed dataset dated at or after 2026-11-05T00:00:00Z matches \"grid\"",
            ),
        ];
        for (args, said) in cases {
            assert_eq!(format_dataset_search_human(&empty, &flags(args)), said);
        }
    }

    const MINE: &str = r#"{
      "results": [{ "group": null, "listings": [
        { "url": "/a.zarr", "title": "a.zarr", "kind": "image" }
      ] }],
      "next_cursor": "eyJuIjoxfQ", "scope": "mine", "mine_available": true, "outside_scope": 4
    }"#;

    #[test]
    fn the_matches_outside_the_scope_are_counted_last() {
        assert_eq!(
            format_dataset_search_human(&page(MINE), &flags(&["--mine"])),
            "a.zarr  (image)\n  /a.zarr\n\
             \n\
             More results: run the same search again with --cursor eyJuIjoxfQ\n\
             \n\
             4 more in everyone's: run again with --everyone"
        );

        let none_mine = page(
            r#"{ "results": [], "next_cursor": null, "scope": "mine",
                 "mine_available": true, "outside_scope": 1 }"#,
        );
        assert_eq!(
            format_dataset_search_human(&none_mine, &flags(&["grid", "--mine"])),
            "None of the matches are yours\n\n1 in everyone's: run again with --everyone"
        );
    }

    #[test]
    fn mine_answered_for_everyone_says_so_first() {
        let everyone = page(
            r#"{
              "results": [{ "group": null, "listings": [
                { "url": "/a.zarr", "title": "a.zarr", "kind": "image" }
              ] }],
              "next_cursor": null, "scope": "everyone", "mine_available": false,
              "outside_scope": 0
            }"#,
        );
        assert_eq!(
            format_dataset_search_human(&everyone, &flags(&["--mine"])),
            "Everyone's datasets: the server doesn't know which are yours\n\
             \n\
             a.zarr  (image)\n  /a.zarr"
        );
        assert_eq!(
            format_dataset_search_human(&everyone, &flags(&[])),
            "a.zarr  (image)\n  /a.zarr"
        );
    }

    /// The server grows its response by adding fields, and leaves out
    /// ones a listing doesn't have.
    #[test]
    fn a_page_reads_without_the_optional_fields_and_past_unknown_ones() {
        let page = page(
            r#"{
              "results": [{ "group": null, "listings": [
                { "url": "/a.zarr", "title": "a.zarr", "kind": "volume", "added": true }
              ] }],
              "next_cursor": null,
              "added_later": 3
            }"#,
        );

        assert_eq!(
            format_dataset_search_human(&page, &words("")),
            "a.zarr  (volume)\n  /a.zarr"
        );
    }

    /// Serve one request with `status` and `body`. The task yields the
    /// request line it was sent.
    async fn serve_once(
        status: &'static str,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let served = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            while !request.windows(4).any(|end| end == b"\r\n\r\n") {
                let read = socket.read(&mut buffer).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            let request = String::from_utf8_lossy(&request).into_owned();
            request.lines().next().unwrap_or_default().to_string()
        });
        (url, served)
    }

    #[tokio::test]
    async fn search_sends_each_flag_as_its_parameter_and_keeps_the_body_as_sent() {
        let cases = [
            (&[][..], "/api/listings"),
            (
                &["two", "words", "--cursor", "abc"],
                "/api/listings?q=two+words&cursor=abc",
            ),
            (&["--mine"], "/api/listings?scope=mine"),
            (&["--everyone"], "/api/listings?scope=everyone"),
            (&["--kind", "image"], "/api/listings?kind=image"),
            (&["--kind", "collection"], "/api/listings?kind=collection"),
            (
                &["--since", "2026-11-05"],
                "/api/listings?since=2026-11-05T00%3A00%3A00Z",
            ),
            (
                &["--since", "2026-11-05T09:30:00-08:00"],
                "/api/listings?since=2026-11-05T17%3A30%3A00Z",
            ),
            (
                &[
                    "grid",
                    "--mine",
                    "--kind",
                    "collection",
                    "--since",
                    "2026-11-05",
                ],
                "/api/listings?q=grid&scope=mine&kind=collection&since=2026-11-05T00%3A00%3A00Z",
            ),
        ];
        let body = r#"{"results":[],"next_cursor":null,"added_later":{"b":1,"a":2}}"#;
        for (args, target) in cases {
            let (url, request_line) = serve_once("200 OK", body).await;
            let found = DatasetSearchClient::new(url, None)
                .search(&flags(args))
                .await
                .unwrap();
            assert_eq!(found.body, body);
            assert!(found.page.results.is_empty());
            assert_eq!(
                request_line.await.unwrap(),
                format!("GET {target} HTTP/1.1")
            );
        }
    }

    #[test]
    fn a_refused_cursor_reports_the_servers_reason() {
        let error = map_search_error(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":"bad_request","detail":"cursor is not one this server returned"}"#,
        );
        assert_eq!(error.kind, ErrorKind::Config);
        assert_eq!(error.message, "cursor is not one this server returned");

        let error = map_search_error(reqwest::StatusCode::UNAUTHORIZED, "");
        assert_eq!(error.kind, ErrorKind::Unauthenticated);
    }
}
