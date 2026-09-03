//! Google Cloud Identity-Aware Proxy: read the identity IAP already
//! established, rather than establishing one of our own.
//!
//! IAP sits in front of the load balancer, authenticates the caller,
//! and attaches a signed assertion to every request it forwards. There
//! is no sign-in flow here and no session to mint — the work is
//! verifying that assertion and turning its `email` claim into an
//! [`AuthPrincipal`].
//!
//! ## The four checks
//!
//! An assertion is accepted only when all four pass:
//!
//! 1. **Signature**, against the IAP key set. IAP signs with ES256 and
//!    publishes its keys somewhere other than the general Google OAuth
//!    JWKS that [`super::google_oauth`] uses. Pointing this at the
//!    wrong key set would produce a check that passes without meaning.
//! 2. **Issuer**, against the configured value.
//! 3. **Expiry**, which `jsonwebtoken` enforces from the `exp` claim.
//! 4. **Audience**, an exact string match against `LUCIDA_IAP_AUDIENCE`.
//!
//! The fourth is the one worth defending. IAP signs every assertion it
//! issues, for every deployment on the platform, with the same keys, so
//! the first three together prove only that *some* IAP minted this
//! token — not that this deployment's did. The audience is what
//! separates the two. It is compared byte for byte: no prefix match, no
//! value assembled from parts, and no switch to turn it off.
//!
//! ## Key set caching
//!
//! Same shape as the OAuth JWKS cache next door. The key set is fetched
//! once at startup and refreshed on two triggers: after
//! [`IAP_KEY_SET_REFRESH_INTERVAL`], and immediately when an assertion
//! names a `kid` the cache does not hold, which is what a rotation
//! looks like from here. Verifying pays no network round trip in the
//! ordinary case.
//!
//! ## Test harness
//!
//! Production reads the key set from `gstatic.com`. Tests point
//! `jwks_uri` at an axum app on an ephemeral port through
//! [`AuthConfig::for_tests_iap`], the same injection the OAuth client
//! uses. Nothing in this module knows the difference; every address
//! comes from config.

use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::http::request::Parts;
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::Deserialize;
use thiserror::Error;
use tokio::sync::RwLock;
use tracing::{debug, error, warn};

use lucida_core::auth_principal::AuthPrincipal;

use super::config::{AuthConfig, IapConfig};
use super::principal::{
    AuthError, PrincipalExtractor, client_ip, display_name_from_email, normalize_email,
};

/// The header IAP attaches to every request it forwards. On the normal
/// request path IAP strips client-supplied `x-goog-*` headers, so a
/// caller cannot forge this one through the load balancer — but that
/// strip happens at the perimeter, and a workload inside the cluster
/// can reach the backend Service without passing through it. The
/// signature and audience checks are what hold in that case.
pub const IAP_ASSERTION_HEADER: &str = "x-goog-iap-jwt-assertion";

/// How long a fetched key set is trusted before the next verification
/// refreshes it. IAP rotates its keys, and an unknown `kid` forces a
/// refetch regardless, so this interval only bounds how stale the
/// cache gets while every assertion still validates.
pub const IAP_KEY_SET_REFRESH_INTERVAL: Duration = Duration::from_secs(24 * 3600);

/// What survives verification. IAP supplies more (`hd`, access levels,
/// device state); lucida consumes an email address and nothing else,
/// because that is all the authorization code ever needed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedAssertion {
    /// The `email` claim, normalized by [`normalize_email`].
    pub email: String,
    /// The `sub` claim: IAP's stable identifier for the caller. An
    /// address can be renamed or handed to somebody else; this cannot,
    /// which makes it the useful field in an audit trail. Optional
    /// rather than defaulted, so an assertion that omits it reads as
    /// absent instead of as an empty identifier.
    pub subject: Option<String>,
}

/// Failure modes from the IAP verifier, split by whose fault it is.
///
/// `AssertionInvalid` is the caller's: the token they presented does
/// not check out, and the answer is 401. The other two are ours —
/// lucida could not reach or read the key set — and the answer is 500.
/// Keeping them apart is what lets an operator tell a wrong
/// `LUCIDA_IAP_AUDIENCE` apart from an outage.
#[derive(Debug, Error)]
pub enum IapError {
    #[error("IAP key set fetch failed: {0}")]
    KeySetFetch(String),
    #[error("IAP assertion rejected: {0}")]
    AssertionInvalid(String),
    /// The cache holds no key under the assertion's `kid`. Its own
    /// variant because [`IapVerifier::verify`] answers it by refetching
    /// once rather than by rejecting, and a rotation is the ordinary
    /// reason to see it.
    #[error("IAP assertion rejected: no key in the cached set matches its kid")]
    UnknownKid,
    #[error("network failure reaching the IAP key set: {0}")]
    Network(String),
}

/// The claims we read off a verified assertion. `iss`, `aud`, and
/// `exp` are checked by [`Validation`] before this is deserialized, so
/// they need no field here.
#[derive(Debug, Deserialize)]
struct IapClaims {
    email: Option<String>,
    sub: Option<String>,
}

/// In-memory key set plus the instant it was fetched. Cache miss is
/// "take the new value and forget the old."
struct KeySetCache {
    keys: JwkSet,
    fetched_at: Instant,
}

/// Verifies IAP assertions against the cached key set. Cheap to clone.
#[derive(Clone)]
pub struct IapVerifier {
    config: Arc<IapConfig>,
    http: reqwest::Client,
    keys: Arc<RwLock<KeySetCache>>,
}

impl IapVerifier {
    /// Build the verifier and prime the key set.
    ///
    /// Fail-fast on the initial fetch, matching the OAuth client: a
    /// server that cannot read the key set cannot authenticate anyone,
    /// and refusing to boot says so once instead of 500ing every
    /// request until somebody reads the logs.
    pub async fn new(config: Arc<IapConfig>) -> Result<Self, IapError> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| IapError::KeySetFetch(e.to_string()))?;

        let initial = fetch_key_set(&http, &config.jwks_uri).await?;
        let keys = Arc::new(RwLock::new(KeySetCache {
            keys: initial,
            fetched_at: Instant::now(),
        }));

        Ok(Self { config, http, keys })
    }

    /// Run the four checks over one assertion.
    ///
    /// An unknown `kid` earns exactly one refetch-and-retry: that is
    /// what a key rotation between two requests looks like, and it is
    /// worth one round trip to absorb. Anything else fails on the spot.
    pub async fn verify(&self, assertion: &str) -> Result<VerifiedAssertion, IapError> {
        let header = decode_header(assertion)
            .map_err(|e| IapError::AssertionInvalid(format!("header decode: {e}")))?;
        let kid = header
            .kid
            .ok_or_else(|| IapError::AssertionInvalid("assertion header names no kid".into()))?;

        if self.cache_is_stale().await {
            self.refresh_key_set().await?;
        }

        match self.try_verify(assertion, &kid).await {
            Err(IapError::UnknownKid) => {
                debug!(kid = %kid, "auth.iap.key_set.refresh.unknown_kid");
                self.refresh_key_set().await?;
                self.try_verify(assertion, &kid).await
            }
            other => other,
        }
    }

    async fn cache_is_stale(&self) -> bool {
        let guard = self.keys.read().await;
        guard.fetched_at.elapsed() > IAP_KEY_SET_REFRESH_INTERVAL
    }

    async fn refresh_key_set(&self) -> Result<(), IapError> {
        let new = fetch_key_set(&self.http, &self.config.jwks_uri).await?;
        let mut guard = self.keys.write().await;
        guard.keys = new;
        guard.fetched_at = Instant::now();
        Ok(())
    }

    async fn try_verify(&self, assertion: &str, kid: &str) -> Result<VerifiedAssertion, IapError> {
        let guard = self.keys.read().await;
        let jwk = guard.keys.find(kid).ok_or(IapError::UnknownKid)?;
        let key = DecodingKey::from_jwk(jwk)
            .map_err(|e| IapError::AssertionInvalid(format!("decoding key: {e}")))?;

        // Pinning one algorithm stops the caller from choosing their own:
        // an assertion whose header says HS256 is rejected before its
        // signature is considered, so the published verification key
        // cannot be replayed as a shared secret.
        let mut validation = Validation::new(Algorithm::ES256);
        validation.set_issuer(&[&self.config.issuer]);
        validation.set_audience(&[&self.config.audience]);
        // `set_issuer` and `set_audience` constrain a claim that is present
        // and say nothing about one that is missing, and the default
        // required set is `exp` alone. Without this, an assertion that
        // omits `aud` skips the one check this provider exists for.
        validation.set_required_spec_claims(&["exp", "iss", "aud"]);

        let data = decode::<IapClaims>(assertion, &key, &validation)
            .map_err(|e| IapError::AssertionInvalid(describe_jwt_error(&e)))?;

        let email = data
            .claims
            .email
            .as_deref()
            .and_then(normalize_email)
            .ok_or_else(|| {
                IapError::AssertionInvalid("assertion carries no usable `email` claim".into())
            })?;

        Ok(VerifiedAssertion {
            email,
            subject: data.claims.sub,
        })
    }
}

/// Turn a `jsonwebtoken` failure into something an operator can act on.
///
/// The default rendering of these is the variant name, which reads the
/// same whether the deployment is under attack or its
/// `LUCIDA_IAP_AUDIENCE` has a typo. Naming the offending env var in
/// the message is the difference between a five-minute fix and an
/// afternoon.
fn describe_jwt_error(err: &jsonwebtoken::errors::Error) -> String {
    use jsonwebtoken::errors::ErrorKind;
    match err.kind() {
        ErrorKind::InvalidAudience => {
            "audience does not match LUCIDA_IAP_AUDIENCE (the assertion was minted for another \
             IAP-protected service)"
                .to_string()
        }
        ErrorKind::InvalidIssuer => "issuer is not the configured IAP issuer".to_string(),
        ErrorKind::ExpiredSignature => "assertion has expired".to_string(),
        ErrorKind::InvalidSignature => "signature does not match the IAP key set".to_string(),
        ErrorKind::InvalidAlgorithm => "assertion is not signed with ES256".to_string(),
        ErrorKind::MissingRequiredClaim(claim) => format!("assertion has no `{claim}` claim"),
        other => format!("{other:?}"),
    }
}

async fn fetch_key_set(http: &reqwest::Client, jwks_uri: &str) -> Result<JwkSet, IapError> {
    let res = http.get(jwks_uri).send().await.map_err(|e| {
        if e.is_connect() || e.is_timeout() || e.is_request() {
            IapError::Network(e.to_string())
        } else {
            IapError::KeySetFetch(e.to_string())
        }
    })?;
    if !res.status().is_success() {
        return Err(IapError::KeySetFetch(format!("status {}", res.status())));
    }
    let set = res
        .json::<JwkSet>()
        .await
        .map_err(|e| IapError::KeySetFetch(format!("decode: {e}")))?;
    if set.keys.is_empty() {
        warn!(jwks_uri, "auth.iap.key_set.empty");
    }
    Ok(set)
}

/// Read the assertion header. `None` for missing, non-ASCII, or empty.
fn read_assertion(req: &Parts) -> Option<&str> {
    let raw = req.headers.get(IAP_ASSERTION_HEADER)?.to_str().ok()?.trim();
    (!raw.is_empty()).then_some(raw)
}

/// Turns a verified IAP assertion into an [`AuthPrincipal`].
///
/// Never produces an identity for a caller who presented nothing: a
/// request with no assertion is unauthenticated, full stop. A
/// deployment that wants every caller to share one identity runs
/// disabled mode on a loopback bind, which ADR-0018 governs.
///
/// Admin rights come from `LUCIDA_ADMIN_EMAILS`, the same mechanism
/// every other provider uses. IAP decides who reaches the server; it
/// has no opinion about who administers lucida.
pub struct IapAssertionExtractor {
    config: Arc<AuthConfig>,
    verifier: Arc<IapVerifier>,
    first_rejection: Once,
}

impl IapAssertionExtractor {
    pub fn new(config: Arc<AuthConfig>, verifier: Arc<IapVerifier>) -> Self {
        Self {
            config,
            verifier,
            first_rejection: Once::new(),
        }
    }
}

#[async_trait]
impl PrincipalExtractor for IapAssertionExtractor {
    /// No. Lucida runs no sign-in under IAP, so `/auth/start` is not
    /// mounted and bouncing a browser into it would loop.
    fn offers_sign_in(&self) -> bool {
        false
    }

    async fn extract(&self, req: &Parts) -> Result<AuthPrincipal, AuthError> {
        let ip = client_ip(req).unwrap_or_default();

        let Some(assertion) = read_assertion(req) else {
            debug!(ip = %ip, "auth.iap.assertion.missing");
            return Err(AuthError::Unauthenticated);
        };

        let verified = match self.verifier.verify(assertion).await {
            Ok(verified) => verified,
            Err(err @ (IapError::AssertionInvalid(_) | IapError::UnknownKid)) => {
                let reason = err.to_string();
                // A misconfigured audience refuses every request while
                // looking, per request, like an ordinary failed sign-in.
                // Say it once at a level the default filter shows, then
                // leave the rest at debug so a caller hammering the door
                // cannot bury the boot log.
                self.first_rejection.call_once(|| {
                    warn!(reason = %reason, "auth.iap.assertion.rejected.first");
                });
                debug!(ip = %ip, reason = %reason, "auth.iap.assertion.rejected");
                return Err(AuthError::Unauthenticated);
            }
            Err(other) => {
                error!(error = %other, "auth.iap.key_set.unavailable");
                return Err(AuthError::Internal(other.to_string()));
            }
        };

        // The env-var parser lowercases one side and `normalize_email` the
        // other, so this lookup cannot miss on casing alone.
        let is_admin = self.config.admin_emails.contains(&verified.email);
        debug!(
            subject = verified.subject.as_deref().unwrap_or(""),
            is_admin, "auth.iap.assertion.accepted",
        );
        Ok(AuthPrincipal {
            display_name: display_name_from_email(&verified.email),
            email: verified.email,
            picture_url: None,
            is_admin,
        })
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! An ES256 signing key and a mock key-set server, shared with the
    //! middleware tests next door so the two cannot drift.

    use std::sync::Arc;

    use axum::Router;
    use axum::extract::State;
    use axum::response::IntoResponse;
    use axum::routing::get;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use p256::SecretKey;
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use p256::pkcs8::{EncodePrivateKey, LineEnding};
    use serde_json::{Value, json};
    use tokio::sync::Mutex;

    /// Stands in for the audience a real deployment configures. The
    /// digits are placeholders, not anybody's project.
    pub const TEST_AUDIENCE: &str =
        "/projects/000000000000/global/backendServices/0000000000000000000";

    /// What [`crate::auth::AuthConfig::for_tests_iap`] configures, so a
    /// test that signs with it needs no further setup.
    pub const TEST_ISSUER: &str = "https://test-iap-issuer";

    /// The claim set IAP mints for a signed-in user. Tests bend one
    /// field at a time to make an assertion that should be refused.
    pub fn test_claims(email: &str) -> Value {
        let now = chrono::Utc::now().timestamp();
        json!({
            "iss": TEST_ISSUER,
            "aud": TEST_AUDIENCE,
            "email": email,
            "sub": "accounts.example.com:000000000000000000000",
            "iat": now - 10,
            "exp": now + 600,
        })
    }

    /// A throwaway P-256 keypair, in the two forms the tests need: a
    /// PKCS#8 PEM to sign with, and a JWK set to serve.
    pub struct TestKey {
        pub kid: String,
        pkcs8_pem: String,
        pub jwks_json: String,
    }

    impl TestKey {
        pub fn generate(kid: &str) -> Self {
            let secret = SecretKey::random(&mut rand::rngs::OsRng);
            let pkcs8_pem = secret
                .to_pkcs8_pem(LineEnding::LF)
                .expect("p256 key encodes as PKCS#8")
                .to_string();
            let point = secret.public_key().to_encoded_point(false);
            let jwks_json = json!({
                "keys": [{
                    "kty": "EC",
                    "crv": "P-256",
                    "alg": "ES256",
                    "use": "sig",
                    "kid": kid,
                    "x": URL_SAFE_NO_PAD.encode(point.x().expect("affine x")),
                    "y": URL_SAFE_NO_PAD.encode(point.y().expect("affine y")),
                }]
            })
            .to_string();

            Self {
                kid: kid.to_string(),
                pkcs8_pem,
                jwks_json,
            }
        }

        /// Sign `claims` as this key would, ES256 with the key's `kid`.
        pub fn sign(&self, claims: &Value) -> String {
            let mut header = Header::new(jsonwebtoken::Algorithm::ES256);
            header.kid = Some(self.kid.clone());
            let key = EncodingKey::from_ec_pem(self.pkcs8_pem.as_bytes()).expect("encoding key");
            encode(&header, claims, &key).expect("encode assertion")
        }
    }

    /// What the mock server is serving and how often it has been asked.
    /// The body is swappable so a test can rotate keys mid-run; the
    /// count is what proves the cache spares the network.
    #[derive(Clone)]
    pub struct MockKeySet {
        state: Arc<Mutex<(String, usize)>>,
    }

    impl MockKeySet {
        pub async fn serve(&self, jwks_json: String) {
            self.state.lock().await.0 = jwks_json;
        }

        pub async fn fetch_count(&self) -> usize {
            self.state.lock().await.1
        }
    }

    async fn key_set(State(mock): State<MockKeySet>) -> impl IntoResponse {
        let mut guard = mock.state.lock().await;
        guard.1 += 1;
        (
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            guard.0.clone(),
        )
    }

    /// Stand up the mock on an ephemeral port. Returns the base URL to
    /// hand [`crate::auth::AuthConfig::for_tests_iap`] and a handle for
    /// swapping the served key set.
    pub async fn spawn_mock_key_set(jwks_json: String) -> (String, MockKeySet) {
        let mock = MockKeySet {
            state: Arc::new(Mutex::new((jwks_json, 0))),
        };
        let app = Router::new()
            .route("/iap-keys", get(key_set))
            .with_state(mock.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock key set");
        let addr = listener.local_addr().expect("mock key set address");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), mock)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::auth::config::AuthConfig;
    use axum::http::Request;
    use chrono::Utc;
    use serde_json::{Value, json};

    use test_claims as claims;

    /// A verifier wired to a mock serving `key`, plus the config it
    /// came from so callers can reach `admin_emails`.
    async fn verifier_for(key: &TestKey) -> (Arc<IapVerifier>, Arc<AuthConfig>, MockKeySet) {
        let (base, mock) = spawn_mock_key_set(key.jwks_json.clone()).await;
        let config = Arc::new(AuthConfig::for_tests_iap(TEST_AUDIENCE, &base));
        let iap = Arc::new(config.iap.clone().expect("IAP block"));
        let verifier = Arc::new(IapVerifier::new(iap).await.expect("key set primes"));
        (verifier, config, mock)
    }

    fn parts_with_assertion(assertion: Option<&str>) -> Parts {
        let mut builder = Request::builder().uri("http://localhost/");
        if let Some(a) = assertion {
            builder = builder.header(IAP_ASSERTION_HEADER, a);
        }
        builder.body(()).unwrap().into_parts().0
    }

    async fn extractor_for(key: &TestKey) -> (IapAssertionExtractor, MockKeySet) {
        let (verifier, config, mock) = verifier_for(key).await;
        (IapAssertionExtractor::new(config, verifier), mock)
    }

    // -- the four checks --------------------------------------------------

    #[tokio::test]
    async fn a_valid_assertion_yields_the_expected_email() {
        let key = TestKey::generate("kid-1");
        let (verifier, _, _) = verifier_for(&key).await;

        let verified = verifier
            .verify(&key.sign(&claims("alice@example.com")))
            .await
            .expect("a well-formed assertion verifies");

        assert_eq!(verified.email, "alice@example.com");
        assert_eq!(
            verified.subject.as_deref(),
            Some("accounts.example.com:000000000000000000000"),
        );
    }

    #[tokio::test]
    async fn an_assertion_for_another_service_is_rejected() {
        // Same IAP, same keys, same issuer, a different deployment. This
        // is the case the audience check exists for.
        let key = TestKey::generate("kid-1");
        let (verifier, _, _) = verifier_for(&key).await;

        let mut other = claims("alice@example.com");
        other["aud"] = json!("/projects/999999999999/global/backendServices/9999999999999999999");

        let err = verifier
            .verify(&key.sign(&other))
            .await
            .expect_err("an assertion minted for another service must not be accepted");
        let message = err.to_string();
        assert!(message.contains("LUCIDA_IAP_AUDIENCE"), "{message}");
    }

    #[tokio::test]
    async fn an_audience_that_only_shares_a_prefix_is_rejected() {
        // A backend service whose id starts with ours is a different
        // backend service.
        let key = TestKey::generate("kid-1");
        let (verifier, _, _) = verifier_for(&key).await;

        let mut extended = claims("alice@example.com");
        extended["aud"] = json!(format!("{TEST_AUDIENCE}9"));

        assert!(verifier.verify(&key.sign(&extended)).await.is_err());
    }

    #[tokio::test]
    async fn an_assertion_with_no_audience_claim_is_rejected() {
        // Omitting a claim must not be a way around checking it. This
        // passed until `set_required_spec_claims` named `aud`.
        let key = TestKey::generate("kid-1");
        let (verifier, _, _) = verifier_for(&key).await;

        let mut anonymous = claims("alice@example.com");
        anonymous.as_object_mut().unwrap().remove("aud");

        let err = verifier
            .verify(&key.sign(&anonymous))
            .await
            .expect_err("an assertion with no audience must not be accepted");
        assert!(err.to_string().contains("aud"), "{err}");
    }

    #[tokio::test]
    async fn an_assertion_with_no_issuer_claim_is_rejected() {
        let key = TestKey::generate("kid-1");
        let (verifier, _, _) = verifier_for(&key).await;

        let mut anonymous = claims("alice@example.com");
        anonymous.as_object_mut().unwrap().remove("iss");

        let err = verifier
            .verify(&key.sign(&anonymous))
            .await
            .expect_err("an assertion with no issuer must not be accepted");
        assert!(err.to_string().contains("iss"), "{err}");
    }

    #[tokio::test]
    async fn an_assertion_with_no_expiry_claim_is_rejected() {
        let key = TestKey::generate("kid-1");
        let (verifier, _, _) = verifier_for(&key).await;

        let mut everlasting = claims("alice@example.com");
        everlasting.as_object_mut().unwrap().remove("exp");

        assert!(verifier.verify(&key.sign(&everlasting)).await.is_err());
    }

    #[tokio::test]
    async fn a_wrong_issuer_is_rejected() {
        let key = TestKey::generate("kid-1");
        let (verifier, _, _) = verifier_for(&key).await;

        let mut forged = claims("alice@example.com");
        forged["iss"] = json!("https://accounts.google.com");

        let err = verifier
            .verify(&key.sign(&forged))
            .await
            .expect_err("only the configured issuer is accepted");
        assert!(err.to_string().contains("issuer"), "{err}");
    }

    #[tokio::test]
    async fn an_expired_assertion_is_rejected() {
        let key = TestKey::generate("kid-1");
        let (verifier, _, _) = verifier_for(&key).await;

        let now = Utc::now().timestamp();
        let mut stale = claims("alice@example.com");
        stale["iat"] = json!(now - 1200);
        stale["exp"] = json!(now - 600);

        let err = verifier
            .verify(&key.sign(&stale))
            .await
            .expect_err("an expired assertion must not be accepted");
        assert!(err.to_string().contains("expired"), "{err}");
    }

    #[tokio::test]
    async fn a_signature_from_another_key_is_rejected() {
        // Same `kid`, different key: what a forged assertion looks like
        // from here.
        let published = TestKey::generate("kid-1");
        let (verifier, _, _) = verifier_for(&published).await;
        let impostor = TestKey::generate("kid-1");

        let err = verifier
            .verify(&impostor.sign(&claims("alice@example.com")))
            .await
            .expect_err("a signature the key set does not back must not be accepted");
        assert!(err.to_string().contains("signature"), "{err}");
    }

    #[tokio::test]
    async fn an_assertion_naming_another_algorithm_is_rejected() {
        let key = TestKey::generate("kid-1");
        let (verifier, _, _) = verifier_for(&key).await;

        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256);
        header.kid = Some(key.kid.clone());
        let symmetric = jsonwebtoken::encode(
            &header,
            &claims("alice@example.com"),
            &jsonwebtoken::EncodingKey::from_secret(b"the-published-key"),
        )
        .expect("encode HS256");

        assert!(verifier.verify(&symmetric).await.is_err());
    }

    #[tokio::test]
    async fn an_assertion_with_no_email_claim_is_rejected() {
        let key = TestKey::generate("kid-1");
        let (verifier, _, _) = verifier_for(&key).await;

        let mut anonymous = claims("alice@example.com");
        anonymous["email"] = Value::Null;

        let err = verifier
            .verify(&key.sign(&anonymous))
            .await
            .expect_err("an assertion that names nobody cannot become a principal");
        assert!(err.to_string().contains("email"), "{err}");
    }

    #[tokio::test]
    async fn the_email_is_normalized_like_every_other_provider() {
        let key = TestKey::generate("kid-1");
        let (verifier, _, _) = verifier_for(&key).await;

        let verified = verifier
            .verify(&key.sign(&claims("  Alice@Example.COM  ")))
            .await
            .unwrap();

        assert_eq!(verified.email, "alice@example.com");
    }

    // -- key set caching --------------------------------------------------

    #[tokio::test]
    async fn verifying_pays_no_network_round_trip() {
        let key = TestKey::generate("kid-1");
        let (verifier, _, mock) = verifier_for(&key).await;
        assert_eq!(mock.fetch_count().await, 1, "priming is the only fetch");

        for _ in 0..3 {
            verifier
                .verify(&key.sign(&claims("alice@example.com")))
                .await
                .unwrap();
        }

        assert_eq!(mock.fetch_count().await, 1, "the cache answered");
    }

    #[tokio::test]
    async fn a_rotated_key_is_picked_up_on_an_unknown_kid() {
        let old = TestKey::generate("kid-old");
        let (verifier, _, mock) = verifier_for(&old).await;

        let new = TestKey::generate("kid-new");
        mock.serve(new.jwks_json.clone()).await;

        let verified = verifier
            .verify(&new.sign(&claims("alice@example.com")))
            .await
            .expect("an unknown kid refetches and retries");

        assert_eq!(verified.email, "alice@example.com");
        assert_eq!(mock.fetch_count().await, 2, "one refetch, not a loop");
    }

    #[tokio::test]
    async fn an_unreachable_key_set_stops_the_verifier_from_being_built() {
        // Port 1 on loopback refuses immediately, so this is the boot case
        // where IAP is configured and the key set is unreachable.
        let config = IapConfig {
            audience: TEST_AUDIENCE.to_string(),
            jwks_uri: "http://127.0.0.1:1/iap-keys".to_string(),
            issuer: TEST_ISSUER.to_string(),
        };
        let err = IapVerifier::new(Arc::new(config))
            .await
            .err()
            .expect("an unreachable key set must not produce a verifier");
        assert!(
            matches!(err, IapError::Network(_) | IapError::KeySetFetch(_)),
            "got {err:?}",
        );
    }

    // -- the extractor seam -----------------------------------------------

    #[tokio::test]
    async fn the_extractor_turns_an_assertion_into_a_principal() {
        let key = TestKey::generate("kid-1");
        let (extractor, _) = extractor_for(&key).await;

        let principal = extractor
            .extract(&parts_with_assertion(Some(
                &key.sign(&claims("test.viewer@example.com")),
            )))
            .await
            .unwrap();

        assert_eq!(principal.email, "test.viewer@example.com");
        assert_eq!(principal.display_name, "Test Viewer");
        assert!(principal.picture_url.is_none(), "IAP supplies no avatar");
        assert!(!principal.is_admin, "no admin list configured = no admins");
    }

    #[tokio::test]
    async fn a_request_with_no_assertion_is_unauthenticated() {
        let key = TestKey::generate("kid-1");
        let (extractor, _) = extractor_for(&key).await;

        assert_eq!(
            extractor
                .extract(&parts_with_assertion(None))
                .await
                .unwrap_err(),
            AuthError::Unauthenticated,
        );
    }

    #[tokio::test]
    async fn a_rejected_assertion_is_a_401_not_a_500() {
        let key = TestKey::generate("kid-1");
        let (extractor, _) = extractor_for(&key).await;

        let mut other = claims("alice@example.com");
        other["aud"] = json!("/projects/999999999999/global/backendServices/9999999999999999999");

        let err = extractor
            .extract(&parts_with_assertion(Some(&key.sign(&other))))
            .await
            .unwrap_err();
        assert_eq!(err, AuthError::Unauthenticated);
        assert_eq!(err.status_code(), axum::http::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn admin_rights_come_from_the_configured_list() {
        let key = TestKey::generate("kid-1");
        let (verifier, config, _) = verifier_for(&key).await;
        let mut config = (*config).clone();
        // The env-var parser lowercases and tests bypass it, so seed the
        // lowercased form directly.
        config.admin_emails = ["admin@example.com".to_string()].into_iter().collect();
        let extractor = IapAssertionExtractor::new(Arc::new(config), verifier);

        let admin = extractor
            .extract(&parts_with_assertion(Some(
                &key.sign(&claims("Admin@Example.com")),
            )))
            .await
            .unwrap();
        assert!(admin.is_admin, "a listed address administers");

        let other = extractor
            .extract(&parts_with_assertion(Some(
                &key.sign(&claims("alice@example.com")),
            )))
            .await
            .unwrap();
        assert!(!other.is_admin);
    }
}
