//! The workspace inbox: bundles people sent with **Send report**, read by
//! an agent with `lucida trace inbox`. A page sends over its session socket
//! ([`send`]); the CLI lists and fetches over HTTP ([`http`]).
//!
//! This is not a server-side trace store (ADR-0050). The server keeps the
//! bytes a person chose to send, reads the header out for listings, and
//! computes nothing. Nothing is uploaded on a run's close, on a schedule,
//! or on any other event.

pub mod http;
pub mod send;
pub mod store;
pub mod store_postgres;
pub(crate) mod store_sql;
pub mod store_sqlite;

pub use http::{InboxState, router};
pub use send::{Report, SendError, receive};
pub use store::{InboxBundle, InboxEntry, InboxStore, NewInboxEntry, StoreError};
pub use store_postgres::PostgresInboxStore;
pub use store_sqlite::SqliteInboxStore;

/// How long the inbox keeps a bundle.
///
/// A fortnight, and the number is about people rather than about disk.
/// A field report is written on the day something went wrong and read
/// by whoever picks it up next, with a weekend or a week off in
/// between; two weeks covers that and is still short enough that an
/// inbox nobody tends empties itself. Anything worth keeping longer is
/// a file: the CLI fetches a bundle to disk, and a bundle on disk is
/// nobody's retention policy but its owner's.
pub const RETENTION_DAYS: i64 = 14;

/// The largest bundle the inbox accepts, in bytes.
///
/// Room for a full-screen retina frame plus the trace document, and well
/// inside what the session socket carries, so an oversize bundle is
/// refused with a sentence rather than a dropped connection. The page
/// checks the same number in `lucida-web/src/trace/reportInbox.ts`;
/// change both together.
pub const MAX_BUNDLE_BYTES: usize = 8 * 1024 * 1024;
