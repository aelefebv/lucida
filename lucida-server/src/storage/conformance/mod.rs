//! Conformance suites: what every implementation of a store trait owes
//! its callers, written once per trait and run against every
//! implementation.
//!
//! A case asserts only what a caller can observe through the trait, never
//! a table, a column, a query plan, or which implementation is running.
//! Adding a case is one `async fn` plus one name in `conformance_suite!`.
//! An implementation that may be unavailable, like PostgreSQL, goes in
//! `when_available:` and its factory returns an `Option`.

use chrono::{DateTime, Utc};

/// Expand one `#[tokio::test]` per case-and-implementation pair.
///
/// The implementation name doubles as the module the tests land in, so a
/// failure reads `inbox::sqlite::a_listing_puts_the_newest_first`:
/// the behavior and the store that broke it. A `when_available:`
/// implementation's factory returns `Option<_>`, and `None` skips the case
/// rather than failing it, with the reason on stderr.
macro_rules! conformance_suite {
    (cases: $cases:tt, over: [$($implementation:ident),+ $(,)?] $(,)?) => {
        $(
            conformance_cases!($implementation, $cases);
        )+
    };
    (
        cases: $cases:tt,
        over: [$($implementation:ident),+ $(,)?],
        when_available: [$($optional:ident),+ $(,)?] $(,)?
    ) => {
        $(
            conformance_cases!($implementation, $cases);
        )+
        $(
            conformance_cases_when_available!($optional, $cases);
        )+
    };
}

/// One implementation's worth of the cross product. Separate from
/// `conformance_suite!` only because a `macro_rules!` metavariable cannot
/// be expanded inside another one's repetition; the case list crosses the
/// boundary as an unexamined token tree.
macro_rules! conformance_cases {
    ($implementation:ident, [$($case:ident),+ $(,)?]) => {
        mod $implementation {
            $(
                #[tokio::test]
                async fn $case() {
                    super::$case(super::$implementation().await).await;
                }
            )+
        }
    };
}

/// The same cross product for an implementation whose store may not be
/// reachable. Split from `conformance_cases!` rather than folded into it
/// so the ordinary implementations keep a factory that cannot answer
/// "not today".
macro_rules! conformance_cases_when_available {
    ($implementation:ident, [$($case:ident),+ $(,)?]) => {
        mod $implementation {
            $(
                #[tokio::test]
                async fn $case() {
                    if let Some(store) = super::$implementation().await {
                        super::$case(store).await;
                    }
                }
            )+
        }
    };
}

mod bearer_tokens;
mod cli_token_authorizations;
mod inbox;
mod login_sessions;
mod pending_auth;
mod workspaces;

/// A fixed instant, `offset_seconds` away from an arbitrary base.
///
/// Cases that write a timestamp and read it back name the value they
/// expect rather than comparing against whatever the clock said. The base
/// carries a fractional second so a store that rounds to whole seconds
/// fails the round-trip instead of passing by luck.
fn instant(offset_seconds: i64) -> DateTime<Utc> {
    at("2026-01-02T03:04:05.250Z") + chrono::Duration::seconds(offset_seconds)
}

/// The instant an RFC 3339 literal names, whatever offset it is spelled
/// in. A case that pins timestamp behavior spells one instant two ways,
/// because a caller's clock is not always UTC.
fn at(rfc3339: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(rfc3339)
        .expect("a case names an instant with a literal, and a literal parses")
        .with_timezone(&Utc)
}
