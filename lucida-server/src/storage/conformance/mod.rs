//! Conformance suites: what every implementation of a store trait owes
//! its callers.
//!
//! One suite per store trait, written once and run against every
//! implementation of that trait. Five of the six traits ship an in-memory
//! store beside the SQLite one, and both must answer the same way; the
//! workspace store has no in-memory implementation, so its suite runs
//! against the SQL ones. Every trait also has a PostgreSQL
//! implementation, which runs when a PostgreSQL is reachable.
//!
//! A case asserts only what a caller can observe through the trait: what
//! you write comes back, what you delete is gone, what should conflict
//! does conflict, what should cascade does cascade, what should be
//! ordered is ordered, and what is written together becomes visible
//! together. Nothing here names a table, a column, a query plan, or which
//! implementation is running. A test that needs one of those is an
//! implementation test and belongs beside that implementation.
//!
//! Adding a case is one `async fn` plus one name in the suite's
//! `conformance_suite!` list, and it then runs everywhere. Adding an
//! implementation is one factory plus one name in the `over:` list, and
//! every case then runs against it.
//!
//! An implementation that needs something the machine may not have goes
//! in `when_available:` instead, and its factory returns an `Option`.

use chrono::{DateTime, Utc};

/// Expand one `#[tokio::test]` per case-and-implementation pair.
///
/// The suite module supplies an `async fn` per case, taking the store
/// under test, and an `async fn` per implementation, returning a fresh
/// one. Both lists are names, and the implementation name doubles as the
/// module the generated tests land in, so a failure reads
/// `bookmarks::sqlite::delete_hands_back_the_row_it_removed`: the behavior
/// and the store that broke it.
///
/// A `when_available:` implementation runs the same cases, but its
/// factory returns `Option<_>` and a `None` skips the case rather than
/// failing it. That is for a store needing a database the machine may
/// not have; the factory is the one place that decides, and it says on
/// stderr why it decided so.
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
mod bookmarks;
mod cli_token_authorizations;
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
