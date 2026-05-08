//! Authentication subsystem.
//!
//! This is the foundation slice (parent PRD #455, slice #456): the
//! `PrincipalExtractor` seam, a `StubPrincipalExtractor` for dev/tests,
//! axum middleware that runs the extractor on every request, and the
//! `/auth/whoami` endpoint that the web client polls. Subsequent
//! slices land cookie/session storage, OAuth handlers, and config.
//!
//! Module map (slice 1 lands the shallow set; deep modules arrive in
//! later slices per PRD #455 §"Crates and modules"):
//!
//! - `principal` — `PrincipalExtractor` trait + `StubPrincipalExtractor`.
//! - `middleware` — axum middleware that attaches the principal to
//!   request extensions.
//! - `handlers` — `/auth/whoami`. Other endpoints land in later slices.

pub mod handlers;
pub mod middleware;
pub mod principal;
