//! `lucida dataset search`: the datasets the server lists, found by words,
//! as the Open dialog finds them.
//!
//! One call fetches one page. Its `next_cursor`, passed back with
//! `--cursor` and the same words, fetches the page after.

use serde::Deserialize;

use crate::credentials::EffectiveToken;
use crate::error::{CliError, ErrorKind};
use crate::http::{api_url, response_detail, send_json};

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

    /// The page of listings that match every word in `words`, starting at
    /// `cursor`. No words match every listing.
    pub async fn search(
        &self,
        words: &str,
        cursor: Option<&str>,
    ) -> Result<ListingSearch, CliError> {
        let mut request = self
            .http
            .get(api_url(&self.base_url, &["api", "listings"])?);
        if !words.is_empty() {
            request = request.query(&[("q", words)]);
        }
        if let Some(cursor) = cursor {
            request = request.query(&[("cursor", cursor)]);
        }
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
/// listings, or a listing that has no group on its own.
pub fn format_dataset_search_human(page: &ListingPage, words: &str) -> String {
    if page.results.is_empty() {
        return if words.is_empty() {
            "The server lists no datasets".to_string()
        } else {
            format!("No listed dataset matches \"{words}\"")
        };
    }
    let mut blocks = page.results.iter().map(format_result).collect::<Vec<_>>();
    if let Some(cursor) = &page.next_cursor {
        blocks.push(format!(
            "More results: run again with the same words and --cursor {cursor}"
        ));
    }
    blocks.join("\n\n")
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
            format_dataset_search_human(&page, "runs"),
            "Folder: runs\n\
             \x20 b.zarr  (image, 2026-11-06)\n\
             \x20   /srv/data/runs/b.zarr\n\
             \x20 a.zarr  (collection, 12 tiles, label: first, 2026-11-05)\n\
             \x20   /srv/data/runs/a.zarr\n\
             \n\
             c.zarr  (collection, 1 tile)\n\
             \x20 gs://bucket/c.zarr\n\
             \n\
             More results: run again with the same words and --cursor eyJuIjoxfQ"
        );
    }

    #[test]
    fn an_empty_page_says_whether_words_narrowed_it() {
        let empty = page(r#"{ "results": [], "next_cursor": null }"#);
        assert_eq!(
            format_dataset_search_human(&empty, ""),
            "The server lists no datasets"
        );
        assert_eq!(
            format_dataset_search_human(&empty, "two words"),
            "No listed dataset matches \"two words\""
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
              "outside_scope": 3
            }"#,
        );

        assert_eq!(
            format_dataset_search_human(&page, ""),
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
    async fn search_sends_the_words_and_cursor_and_keeps_the_body_as_sent() {
        let body = r#"{"results":[],"next_cursor":null,"added_later":{"b":1,"a":2}}"#;
        let (url, request_line) = serve_once("200 OK", body).await;
        let found = DatasetSearchClient::new(url, None)
            .search("two words", Some("abc"))
            .await
            .unwrap();
        assert_eq!(found.body, body);
        assert!(found.page.results.is_empty());
        assert_eq!(
            request_line.await.unwrap(),
            "GET /api/listings?q=two+words&cursor=abc HTTP/1.1"
        );

        let (url, request_line) = serve_once("200 OK", body).await;
        DatasetSearchClient::new(url, None)
            .search("", None)
            .await
            .unwrap();
        assert_eq!(request_line.await.unwrap(), "GET /api/listings HTTP/1.1");
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
