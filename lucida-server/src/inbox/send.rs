//! Receiving a **Send report**: what the server checks, what it keeps,
//! and what it refuses.
//!
//! Everything here is about the envelope. The server reads the bundle's
//! `format` to know it is holding a bundle, reads its `header` out so a
//! listing needs no parse, measures it, and stores the text unchanged.
//! It derives nothing else and it writes no row of its own (ADR-0050 as
//! amended). Whether the run inside the bundle is any good is a question
//! for whoever reads it.
//!
//! A refusal keeps nothing. The sender is told why in a sentence the
//! monitor shows under the action, so the reasons here are written for
//! the person who pressed it.

use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::value::RawValue;
use thiserror::Error;

use super::store::{InboxEntry, InboxStore, NewInboxEntry, StoreError};
use super::{MAX_BUNDLE_BYTES, RETENTION_DAYS};

/// What a bundle says it is. The page writes this, the CLI reads it to
/// tell a bundle from a saved run, and the inbox refuses anything else.
pub const BUNDLE_FORMAT: &str = "lucida-trace-bundle";

/// One **Send report**, as the socket handler has it: the bundle, and
/// who sent it from where and when.
#[derive(Debug, Clone, Copy)]
pub struct Report<'a> {
    pub workspace_id: &'a str,
    /// The email of the principal on the session that sent it.
    pub sender_email: &'a str,
    /// How to show them. May be empty.
    pub sender_name: &'a str,
    /// The bundle, exactly as it arrived on the wire.
    pub bundle_json: &'a str,
    /// The clock the entry is stamped and expired against.
    pub now: DateTime<Utc>,
}

/// Why nothing was kept. Every variant's `Display` is what the sender is
/// shown, so each one says what happened rather than naming a rule.
#[derive(Debug, Error)]
pub enum SendError {
    #[error(
        "the bundle is {bytes} bytes, over the inbox's {cap}-byte limit; \
         save it to a file and attach it instead"
    )]
    TooLarge { bytes: usize, cap: usize },
    #[error("the bundle is not readable as JSON: {0}")]
    Unreadable(String),
    #[error("this is not a lucida trace bundle: it does not say `format: {BUNDLE_FORMAT}`")]
    NotABundle,
    #[error("the bundle carries no header, so the inbox could not describe it")]
    NoHeader,
    #[error("the inbox could not store the bundle: {0}")]
    Store(String),
}

impl From<StoreError> for SendError {
    fn from(error: StoreError) -> Self {
        Self::Store(error.to_string())
    }
}

/// Check the bundle, store it, and hand back the entry it landed in.
///
/// The entry's id is what the sender is told and what a fetch takes, and
/// its `expires_at` is what the sender is told the inbox will keep it
/// until.
pub async fn receive(store: &dyn InboxStore, report: Report<'_>) -> Result<InboxEntry, SendError> {
    let header = header_of(report.bundle_json)?;
    let entry = store
        .put(NewInboxEntry {
            workspace_id: report.workspace_id,
            sent_by: report.sender_email,
            sent_by_name: report.sender_name,
            sent_at: report.now,
            expires_at: expires_at(report.now),
            header_json: header,
            bundle_json: report.bundle_json,
        })
        .await?;
    Ok(entry)
}

/// When an entry sent at `now` stops being visible.
pub fn expires_at(now: DateTime<Utc>) -> DateTime<Utc> {
    now + Duration::days(RETENTION_DAYS)
}

/// The `header` section of a bundle, as the slice of text it occupies in
/// the bundle itself.
///
/// Borrowed rather than rebuilt: what the listing shows has to be what
/// the page wrote, down to the order of the fields. The parse walks the
/// whole document, which is unavoidable — a header is not at a known
/// offset — but it materialises only this one section.
pub fn header_of(bundle_json: &str) -> Result<&str, SendError> {
    if bundle_json.len() > MAX_BUNDLE_BYTES {
        return Err(SendError::TooLarge {
            bytes: bundle_json.len(),
            cap: MAX_BUNDLE_BYTES,
        });
    }
    let bundle: BundleEnvelope<'_> = serde_json::from_str(bundle_json)
        .map_err(|error| SendError::Unreadable(error.to_string()))?;
    if bundle.format != Some(BUNDLE_FORMAT) {
        return Err(SendError::NotABundle);
    }
    let header = bundle
        .header
        .map(RawValue::get)
        .ok_or(SendError::NoHeader)?;
    // A `header` that is null, or a number, describes nothing. The text
    // is the source slice, so the check is on the first thing in it that
    // is not whitespace.
    if !header.trim_start().starts_with('{') {
        return Err(SendError::NoHeader);
    }
    Ok(header)
}

/// The two fields the inbox reads. Everything else in a bundle passes
/// through untouched, which is why this borrows from the input and
/// names nothing it does not use.
#[derive(Debug, Deserialize)]
struct BundleEnvelope<'a> {
    #[serde(borrow, default)]
    format: Option<&'a str>,
    #[serde(borrow, default)]
    header: Option<&'a RawValue>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle_with(header: &str) -> String {
        format!(r#"{{"format":"{BUNDLE_FORMAT}","bundleVersion":1,"header":{header}}}"#)
    }

    #[test]
    fn the_header_comes_back_as_the_page_wrote_it() {
        let header = r#"{"runId":"remote-cold","endReason":"quiescent","durationUs":4200000}"#;
        assert_eq!(header_of(&bundle_with(header)).unwrap(), header);
    }

    #[test]
    fn a_bundle_that_is_not_one_is_refused_before_anything_is_kept() {
        let saved_run = r#"{"schemaVersion":2,"runs":[]}"#;
        assert!(matches!(header_of(saved_run), Err(SendError::NotABundle)));
    }

    #[test]
    fn a_bundle_without_a_header_object_is_refused() {
        for header in ["null", "42", r#""a header""#] {
            assert!(
                matches!(header_of(&bundle_with(header)), Err(SendError::NoHeader)),
                "a `header` of {header} describes nothing",
            );
        }
        assert!(matches!(
            header_of(r#"{"format":"lucida-trace-bundle"}"#),
            Err(SendError::NoHeader)
        ));
    }

    #[test]
    fn text_that_is_not_json_is_refused_with_what_the_parser_saw() {
        let error = header_of("not json at all").unwrap_err();
        assert!(
            matches!(error, SendError::Unreadable(ref reason) if !reason.is_empty()),
            "got {error}",
        );
    }

    /// The cap is checked on the length before the bundle is parsed, and
    /// the refusal names both numbers, because "too big" without a limit
    /// leaves the sender nothing to act on.
    #[test]
    fn a_bundle_over_the_cap_is_refused_and_says_both_numbers() {
        let oversized = "\"".repeat(MAX_BUNDLE_BYTES + 1);
        let error = header_of(&oversized).unwrap_err();
        let SendError::TooLarge { bytes, cap } = error else {
            panic!("got {error}");
        };
        assert_eq!(bytes, MAX_BUNDLE_BYTES + 1);
        assert_eq!(cap, MAX_BUNDLE_BYTES);
    }

    #[test]
    fn retention_is_the_fixed_number_of_days_past_the_send() {
        let now = "2026-09-09T14:05:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(
            expires_at(now),
            "2026-09-23T14:05:00Z".parse::<DateTime<Utc>>().unwrap(),
        );
        assert_eq!(RETENTION_DAYS, 14);
    }
}
