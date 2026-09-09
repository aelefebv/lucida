//! The workspace inbox: bundles people sent with **Send report**.
//!
//! A person watching a slow session presses **Send report** in the
//! monitor; the bundle it produces lands here; an agent that was never
//! in that session reads it with `lucida trace inbox`. That is the whole
//! feature, and the two halves of it live in two places for the reason
//! each caller already exists there: a page has a session socket, so the
//! send is a socket message ([`send`], driven from the socket handler),
//! and the CLI has a bearer token, so listing and fetching are HTTP
//! routes ([`http`]).
//!
//! **This is not the server-side trace store ADR-0050 rejected**, and
//! the difference is not a matter of degree. The server writes no row of
//! its own here: it stores the bytes a person chose to send it, reads
//! the header out so a listing can be printed without a parse, and
//! computes nothing over either. A bundle exists in this table because
//! somebody pressed a button, and it leaves it when the retention says
//! so. Nothing is uploaded on a run's close, on a schedule, or on any
//! other event. See ADR-0050 as amended by the monitor spec.
//!
//! Module layout:
//!
//! - [`store`] — the `InboxStore` trait and the records it hands out,
//!   with one module per implementation beside it: [`store_sqlite`],
//!   [`store_postgres`], and [`store_sql`] for what the two share.
//! - [`send`] — what the server checks before it keeps a bundle, and
//!   what it tells a sender when it keeps nothing.
//! - [`http`] — the two read routes and the membership check in front
//!   of them.

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
/// A bundle is mostly its settled frame — a PNG at the run's device
/// pixel ratio — beside a trace document of a few hundred kilobytes.
/// Eight megabytes carries a retina frame of a full-screen viewport with
/// room over, and stays well inside the frame the session socket will
/// carry, so a bundle at the limit is refused with a sentence rather
/// than by the connection dropping.
///
/// The page checks the same number before it sends, so the usual way to
/// meet this limit is a message that says so with the bundle still in
/// the browser. `lucida-web/src/trace/reportInbox.ts` holds that copy of
/// it; the two are a pair, and neither is safe to change alone.
pub const MAX_BUNDLE_BYTES: usize = 8 * 1024 * 1024;
