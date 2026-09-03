//! What both SQL-backed `CliTokenAuthorizationStore` implementations
//! share: the statements they run, and how a driver error becomes a store
//! error.
//!
//! **Number the placeholders, `$1` and up, and never mix `$1` and `?` in
//! one statement.** A mixed statement binds the same argument to both,
//! reports no error, and returns a wrong answer. ADR-0058 has the
//! reasoning and [`super::pending_auth_sql`] the longer note.

/// Insert a freshly-minted approval request.
///
/// Four uniqueness rules ride on this one statement: the primary key on
/// `id`, and a unique index each on the poll secret, the credential hash,
/// and the user code. One poll secret unlocks one request, one approval
/// mints one credential, and the code a person reads out names one
/// request.
pub(crate) const INSERT: &str = r#"
    INSERT INTO cli_token_authorizations
        (id, poll_token_hash, token_hash, user_code, name,
         created_at, expires_at, token_expires_at,
         approved_at, approved_token_id, approved_email)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
"#;

/// Read one request by id, for the browser that is being asked to
/// approve it.
pub(crate) const SELECT_BY_ID: &str = r#"
    SELECT id, poll_token_hash, token_hash, user_code, name,
           created_at, expires_at, token_expires_at,
           approved_at, approved_token_id, approved_email
    FROM cli_token_authorizations
    WHERE id = $1
"#;

/// Read one request for the client polling it.
///
/// The poll secret is part of the lookup rather than checked afterwards,
/// so the request id alone reveals nothing about the approval.
pub(crate) const SELECT_FOR_POLL: &str = r#"
    SELECT id, poll_token_hash, token_hash, user_code, name,
           created_at, expires_at, token_expires_at,
           approved_at, approved_token_id, approved_email
    FROM cli_token_authorizations
    WHERE id = $1 AND poll_token_hash = $2
"#;

/// Stamp a request as approved.
///
/// `COALESCE` on all three columns keeps the first approver: a second
/// approval must not re-point an approved request at another credential
/// or another person. Affecting no rows is the expected outcome for a
/// request that expired before the browser reached it.
pub(crate) const MARK_APPROVED: &str = r#"
    UPDATE cli_token_authorizations
    SET approved_at = COALESCE(approved_at, $1),
        approved_token_id = COALESCE(approved_token_id, $2),
        approved_email = COALESCE(approved_email, $3)
    WHERE id = $4
"#;

/// A driver error, as the trait reports it. One function per store, not
/// one per implementation: a second copy would only be a second place for
/// the two to disagree.
pub(crate) fn map_err(e: sqlx::Error) -> super::cli_authorization::CliTokenAuthorizationStoreError {
    super::cli_authorization::CliTokenAuthorizationStoreError::Backend(e.to_string())
}
