//! One admission boundary for every dataset source the server can reach.
//!
//! The policy is intentionally deny-by-default. Local sources must resolve
//! under an operator-configured root; HTTP hosts/CIDRs and cloud buckets must
//! be explicitly named. HTTP DNS answers are checked and then pinned into a
//! no-redirect, no-proxy client so the address used for I/O cannot differ from
//! the address admitted here.

use std::collections::BTreeSet;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use lucida_content::url::{CanonicalDatasetUrl, SourceIdentity};
use object_store::ObjectStore;
use object_store::client::{HttpClient, HttpConnector};
use object_store::http::HttpBuilder;
use serde::Serialize;

#[derive(Debug, Clone, Default)]
pub struct SourceTrustConfig {
    pub local_roots: Vec<PathBuf>,
    pub http_hosts: Vec<String>,
    pub http_cidrs: Vec<String>,
    /// Operator-specific IPv6 translation/transition prefixes that must never
    /// be admitted. The built-in classifier already rejects the standardized
    /// NAT64, mapped/compatible, Teredo, 6to4, and ISATAP forms; this list
    /// closes the intentionally-uninferrable RFC 6052 network-specific-prefix
    /// gap for a deployment's own routing domain.
    pub http_ipv6_translation_cidrs: Vec<String>,
    pub s3_buckets: Vec<String>,
    pub gcs_buckets: Vec<String>,
    pub allow_ambient_cloud_credentials: bool,
}

#[derive(Debug, Clone)]
pub struct SourceTrustPolicy {
    local_roots: Vec<PathBuf>,
    local_root_capabilities: Vec<lucida_store::backend::ConfinedLocalRoot>,
    http_hosts: BTreeSet<String>,
    http_cidrs: Vec<IpCidr>,
    http_ipv6_translation_cidrs: Vec<IpCidr>,
    s3_buckets: BTreeSet<String>,
    gcs_buckets: BTreeSet<String>,
    allow_ambient_cloud_credentials: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourcePolicyCategory {
    InvalidLocator,
    SchemeDenied,
    LocalRootDenied,
    NetworkTargetDenied,
    CloudScopeDenied,
    ResolutionFailed,
}

/// A dataset-source diagnostic that can safely cross terminal, JSON, tracing,
/// `Display`, and `Debug` boundaries. The raw locator is consumed to derive a
/// lossy hint and opaque full fingerprint, then discarded.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct SafeSourceDiagnostic {
    hint: String,
    fingerprint: String,
}

impl SafeSourceDiagnostic {
    pub fn from_untrusted(raw: &str) -> Self {
        let hint = SourceTrustPolicy::deny_all().redact_untrusted(raw);
        let fingerprint = SourceIdentity::parse(raw)
            .map(|identity| identity.dataset_id())
            .unwrap_or_else(|_| format!("source-blake3-{}", blake3::hash(raw.as_bytes()).to_hex()));
        Self { hint, fingerprint }
    }

    pub fn hint(&self) -> &str {
        &self.hint
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

impl fmt::Debug for SafeSourceDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SafeSourceDiagnostic")
            .field("hint", &self.hint)
            .field("fingerprint", &self.fingerprint)
            .finish()
    }
}

impl fmt::Display for SafeSourceDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", self.hint, self.fingerprint)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourcePolicyError {
    pub category: SourcePolicyCategory,
    message: String,
}

impl SourcePolicyError {
    fn new(category: SourcePolicyCategory, message: impl Into<String>) -> Self {
        Self {
            category,
            message: message.into(),
        }
    }
}

impl fmt::Display for SourcePolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SourcePolicyError {}

#[derive(Debug, Clone)]
enum AdmittedKind {
    Standard,
    Local(lucida_store::backend::AdmittedLocalDataset),
    Http {
        host: String,
        addresses: Vec<SocketAddr>,
        allow_http: bool,
    },
}

#[derive(Debug, Clone)]
pub struct AdmittedSource {
    pub identity: SourceIdentity,
    canonical_url: CanonicalDatasetUrl,
    redacted: String,
    kind: AdmittedKind,
}

impl AdmittedSource {
    pub fn canonical_url(&self) -> &str {
        self.canonical_url.as_str()
    }

    pub fn redacted(&self) -> &str {
        &self.redacted
    }

    pub fn open_backend(&self) -> Result<Arc<dyn ObjectStore>, lucida_store::backend::StoreError> {
        match &self.kind {
            AdmittedKind::Standard => lucida_store::backend::open(self.canonical_url()),
            AdmittedKind::Local(dataset) => Ok(dataset.open_backend()),
            AdmittedKind::Http {
                host,
                addresses,
                allow_http,
            } => {
                let transport_host = reqwest::Url::parse(self.canonical_url())
                    .ok()
                    .and_then(|url| url.host_str().map(normalize_http_host))
                    .ok_or_else(|| {
                        lucida_store::backend::StoreError::SourceConfiguration(
                            "admitted HTTP transport URL has no valid host".into(),
                        )
                    })?;
                if transport_host != *host {
                    return Err(lucida_store::backend::StoreError::SourceConfiguration(
                        "admitted HTTP transport host does not match its DNS pin".into(),
                    ));
                }
                let client = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .no_proxy()
                    .https_only(!allow_http)
                    .connect_timeout(Duration::from_secs(5))
                    .timeout(Duration::from_secs(5))
                    .resolve_to_addrs(host, addresses)
                    .build()
                    .map_err(|error| {
                        lucida_store::backend::StoreError::SourceConfiguration(format!(
                            "admitted HTTP transport could not be built: {error}"
                        ))
                    })?;
                let store = HttpBuilder::new()
                    .with_url(self.canonical_url())
                    .with_retry(lucida_store::backend::source_retry_config())
                    .with_http_connector(PinnedHttpConnector { client })
                    .build()?;
                Ok(Arc::new(store))
            }
        }
    }
}

#[derive(Debug, Clone)]
struct PinnedHttpConnector {
    client: reqwest::Client,
}

impl HttpConnector for PinnedHttpConnector {
    fn connect(&self, _options: &object_store::ClientOptions) -> object_store::Result<HttpClient> {
        Ok(HttpClient::new(self.client.clone()))
    }
}

impl SourceTrustPolicy {
    pub fn deny_all() -> Self {
        Self {
            local_roots: Vec::new(),
            local_root_capabilities: Vec::new(),
            http_hosts: BTreeSet::new(),
            http_cidrs: Vec::new(),
            http_ipv6_translation_cidrs: Vec::new(),
            s3_buckets: BTreeSet::new(),
            gcs_buckets: BTreeSet::new(),
            allow_ambient_cloud_credentials: false,
        }
    }

    pub fn from_config(config: SourceTrustConfig) -> Result<Self, SourcePolicyError> {
        let mut local_roots = Vec::with_capacity(config.local_roots.len());
        for root in config.local_roots {
            let root = std::fs::canonicalize(&root).map_err(|_| {
                SourcePolicyError::new(
                    SourcePolicyCategory::InvalidLocator,
                    "configured dataset root is unavailable",
                )
            })?;
            if !root.is_dir() {
                return Err(SourcePolicyError::new(
                    SourcePolicyCategory::InvalidLocator,
                    "configured dataset root is not a directory",
                ));
            }
            if !local_roots
                .iter()
                .any(|(configured, _)| configured == &root)
            {
                let capability =
                    lucida_store::backend::ConfinedLocalRoot::new(&root).map_err(|_| {
                        SourcePolicyError::new(
                            SourcePolicyCategory::InvalidLocator,
                            "configured dataset root cannot be confined safely",
                        )
                    })?;
                local_roots.push((root, capability));
            }
        }
        local_roots.sort_by(|left, right| left.0.cmp(&right.0));
        let (local_roots, local_root_capabilities): (Vec<_>, Vec<_>) =
            local_roots.into_iter().unzip();

        let normalize_names = |values: Vec<String>| -> BTreeSet<String> {
            values
                .into_iter()
                .map(|value| value.trim().trim_end_matches('.').to_ascii_lowercase())
                .filter(|value| !value.is_empty())
                .collect()
        };
        let http_cidrs = config
            .http_cidrs
            .into_iter()
            .map(|value| IpCidr::parse(&value))
            .collect::<Result<Vec<_>, _>>()?;
        let http_ipv6_translation_cidrs = config
            .http_ipv6_translation_cidrs
            .into_iter()
            .map(|value| {
                let cidr = IpCidr::parse(&value)?;
                if !matches!(cidr.network, IpAddr::V6(_)) {
                    return Err(SourcePolicyError::new(
                        SourcePolicyCategory::InvalidLocator,
                        "HTTP IPv6 translation CIDR must use an IPv6 network address",
                    ));
                }
                Ok(cidr)
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self {
            local_roots,
            local_root_capabilities,
            http_hosts: normalize_names(config.http_hosts),
            http_cidrs,
            http_ipv6_translation_cidrs,
            s3_buckets: normalize_names(config.s3_buckets),
            gcs_buckets: normalize_names(config.gcs_buckets),
            allow_ambient_cloud_credentials: config.allow_ambient_cloud_credentials,
        })
    }

    pub fn local_roots(&self) -> &[PathBuf] {
        &self.local_roots
    }

    /// Produce a log/diagnostic-safe description without first trusting or
    /// resolving the locator. This is deliberately lossy: credentials and
    /// object/path components are never retained.
    pub fn redact_untrusted(&self, raw: &str) -> String {
        let canonical = match CanonicalDatasetUrl::parse(raw) {
            Ok(canonical) => canonical,
            Err(_) => return "<invalid-dataset-source>".to_string(),
        };
        let locator = canonical.as_str();
        if lucida_content::url::is_local_dataset_url(locator) {
            return "<local-dataset-source>".to_string();
        }
        if locator.starts_with("http://") || locator.starts_with("https://") {
            return reqwest::Url::parse(locator)
                .ok()
                .and_then(|parsed| {
                    let host = parsed.host_str()?;
                    let port = parsed
                        .port()
                        .map(|port| format!(":{port}"))
                        .unwrap_or_default();
                    Some(format!("{}://{host}{port}/<redacted>", parsed.scheme()))
                })
                .unwrap_or_else(|| "<invalid-http-dataset-source>".to_string());
        }
        for (prefix, scheme) in [("s3://", "s3"), ("gs://", "gs")] {
            if let Some(rest) = locator.strip_prefix(prefix) {
                let bucket = rest.split('/').next().unwrap_or_default();
                return if bucket.is_empty() {
                    format!("{scheme}://<invalid-bucket>/<redacted>")
                } else {
                    format!("{scheme}://{bucket}/<redacted>")
                };
            }
        }
        "<denied-dataset-source>".to_string()
    }

    pub async fn admit(&self, raw: &str) -> Result<AdmittedSource, SourcePolicyError> {
        let identity = SourceIdentity::parse(raw).map_err(|_| {
            SourcePolicyError::new(
                SourcePolicyCategory::InvalidLocator,
                "dataset source locator is invalid",
            )
        })?;
        let canonical = identity.locator.clone();
        let locator = canonical.as_str();

        if lucida_content::url::is_local_dataset_url(locator) {
            return self.admit_local(identity).await;
        }
        if locator.starts_with("http://") || locator.starts_with("https://") {
            return self.admit_http(identity).await;
        }
        if let Some(rest) = locator.strip_prefix("s3://") {
            return self.admit_cloud(identity, rest, true);
        }
        if let Some(rest) = locator.strip_prefix("gs://") {
            return self.admit_cloud(identity, rest, false);
        }
        Err(SourcePolicyError::new(
            SourcePolicyCategory::SchemeDenied,
            "dataset source scheme is not allowed",
        ))
    }

    pub async fn admit_local_path(&self, raw: &Path) -> Result<PathBuf, SourcePolicyError> {
        if self.local_roots.is_empty() {
            return Err(SourcePolicyError::new(
                SourcePolicyCategory::LocalRootDenied,
                "local dataset sources are disabled",
            ));
        }
        let canonical = tokio::fs::canonicalize(raw).await.map_err(|_| {
            SourcePolicyError::new(
                SourcePolicyCategory::InvalidLocator,
                "local dataset source is unavailable",
            )
        })?;
        if !self
            .local_roots
            .iter()
            .any(|root| canonical.starts_with(root))
        {
            return Err(SourcePolicyError::new(
                SourcePolicyCategory::LocalRootDenied,
                "local dataset source is outside configured roots",
            ));
        }
        Ok(canonical)
    }

    async fn admit_local(
        &self,
        identity: SourceIdentity,
    ) -> Result<AdmittedSource, SourcePolicyError> {
        let canonical_path = self
            .admit_local_path(Path::new(identity.locator.as_str()))
            .await?;
        let root_index = self
            .local_roots
            .iter()
            .position(|root| canonical_path.starts_with(root))
            .ok_or_else(|| {
                SourcePolicyError::new(
                    SourcePolicyCategory::LocalRootDenied,
                    "local dataset source is outside configured roots",
                )
            })?;
        let local_dataset = self.local_root_capabilities[root_index]
            .admit_canonical_dataset(&canonical_path)
            .map_err(|_| {
                SourcePolicyError::new(
                    SourcePolicyCategory::LocalRootDenied,
                    "local dataset source changed or could not be confined during admission",
                )
            })?;
        let canonical_url =
            CanonicalDatasetUrl::parse(&canonical_path.to_string_lossy()).map_err(|_| {
                SourcePolicyError::new(
                    SourcePolicyCategory::InvalidLocator,
                    "canonical local dataset source is invalid",
                )
            })?;
        let identity = SourceIdentity::parse(canonical_url.as_str()).map_err(|_| {
            SourcePolicyError::new(
                SourcePolicyCategory::InvalidLocator,
                "canonical local dataset identity is invalid",
            )
        })?;
        Ok(AdmittedSource {
            identity,
            canonical_url,
            redacted: "<local-dataset-source>".to_string(),
            kind: AdmittedKind::Local(local_dataset),
        })
    }

    async fn admit_http(
        &self,
        identity: SourceIdentity,
    ) -> Result<AdmittedSource, SourcePolicyError> {
        let parsed = reqwest::Url::parse(identity.locator.as_str()).map_err(|_| {
            SourcePolicyError::new(
                SourcePolicyCategory::InvalidLocator,
                "HTTP dataset source is invalid",
            )
        })?;
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(SourcePolicyError::new(
                SourcePolicyCategory::InvalidLocator,
                "HTTP dataset sources may not embed credentials",
            ));
        }
        let host = parsed.host_str().map(normalize_http_host).ok_or_else(|| {
            SourcePolicyError::new(
                SourcePolicyCategory::InvalidLocator,
                "HTTP dataset source is missing a host",
            )
        })?;
        let port = parsed.port_or_known_default().ok_or_else(|| {
            SourcePolicyError::new(
                SourcePolicyCategory::InvalidLocator,
                "HTTP dataset source has no usable port",
            )
        })?;
        let addresses = if let Ok(address) = host.parse::<IpAddr>() {
            vec![SocketAddr::new(address, port)]
        } else {
            tokio::net::lookup_host((host.as_str(), port))
                .await
                .map_err(|_| {
                    SourcePolicyError::new(
                        SourcePolicyCategory::ResolutionFailed,
                        "HTTP dataset host could not be resolved",
                    )
                })?
                .collect::<Vec<_>>()
        };
        self.admit_http_resolved(identity, parsed, host, addresses)
    }

    fn admit_http_resolved(
        &self,
        _identity: SourceIdentity,
        mut parsed: reqwest::Url,
        host: String,
        mut addresses: Vec<SocketAddr>,
    ) -> Result<AdmittedSource, SourcePolicyError> {
        let host = normalize_http_host(&host);
        if parsed.host_str().map(normalize_http_host).as_deref() != Some(host.as_str()) {
            return Err(SourcePolicyError::new(
                SourcePolicyCategory::InvalidLocator,
                "resolved HTTP host does not match the dataset URL",
            ));
        }
        if parsed.host_str() != Some(host.as_str()) {
            parsed.set_host(Some(&host)).map_err(|_| {
                SourcePolicyError::new(
                    SourcePolicyCategory::InvalidLocator,
                    "HTTP dataset host could not be canonicalized",
                )
            })?;
        }
        addresses.sort();
        addresses.dedup();
        if addresses.is_empty() {
            return Err(SourcePolicyError::new(
                SourcePolicyCategory::ResolutionFailed,
                "HTTP dataset host resolved to no addresses",
            ));
        }
        let explicitly_allowed_host = self.http_hosts.contains(&host);
        let every_address_in_allowed_cidr = addresses.iter().all(|address| {
            self.http_cidrs
                .iter()
                .any(|cidr| cidr.contains(address.ip()))
        });
        if !explicitly_allowed_host && !every_address_in_allowed_cidr {
            return Err(SourcePolicyError::new(
                SourcePolicyCategory::NetworkTargetDenied,
                "HTTP dataset host is not allowlisted",
            ));
        }
        for address in &addresses {
            if is_embedded_or_transition_address(address.ip())
                || self
                    .http_ipv6_translation_cidrs
                    .iter()
                    .any(|cidr| cidr.contains(address.ip()))
            {
                return Err(SourcePolicyError::new(
                    SourcePolicyCategory::NetworkTargetDenied,
                    "HTTP dataset host resolves through an IPv6 translation or transition address",
                ));
            }
            if !is_public_address(address.ip())
                && !self
                    .http_cidrs
                    .iter()
                    .any(|cidr| cidr.contains(address.ip()))
            {
                return Err(SourcePolicyError::new(
                    SourcePolicyCategory::NetworkTargetDenied,
                    "HTTP dataset host resolves to a local or reserved address",
                ));
            }
        }

        let port = parsed
            .port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default();
        let canonical_url = CanonicalDatasetUrl::parse(parsed.as_str()).map_err(|_| {
            SourcePolicyError::new(
                SourcePolicyCategory::InvalidLocator,
                "canonical HTTP dataset source is invalid",
            )
        })?;
        let identity = SourceIdentity::parse(canonical_url.as_str()).map_err(|_| {
            SourcePolicyError::new(
                SourcePolicyCategory::InvalidLocator,
                "canonical HTTP dataset identity is invalid",
            )
        })?;
        Ok(AdmittedSource {
            canonical_url,
            identity,
            redacted: format!("{}://{host}{port}/<redacted>", parsed.scheme()),
            kind: AdmittedKind::Http {
                host,
                addresses,
                allow_http: parsed.scheme() == "http",
            },
        })
    }

    fn admit_cloud(
        &self,
        identity: SourceIdentity,
        rest: &str,
        s3: bool,
    ) -> Result<AdmittedSource, SourcePolicyError> {
        if !self.allow_ambient_cloud_credentials {
            return Err(SourcePolicyError::new(
                SourcePolicyCategory::CloudScopeDenied,
                "ambient cloud credentials are disabled for dataset sources",
            ));
        }
        let bucket = rest
            .split('/')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let allowed = if s3 {
            self.s3_buckets.contains(&bucket)
        } else {
            self.gcs_buckets.contains(&bucket)
        };
        if bucket.is_empty() || !allowed {
            return Err(SourcePolicyError::new(
                SourcePolicyCategory::CloudScopeDenied,
                "cloud dataset bucket is not allowlisted",
            ));
        }
        let scheme = if s3 { "s3" } else { "gs" };
        Ok(AdmittedSource {
            canonical_url: identity.locator.clone(),
            identity,
            redacted: format!("{scheme}://{bucket}/<redacted>"),
            kind: AdmittedKind::Standard,
        })
    }
}

fn normalize_http_host(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IpCidr {
    network: IpAddr,
    prefix: u8,
}

impl IpCidr {
    fn parse(raw: &str) -> Result<Self, SourcePolicyError> {
        let (address, prefix) = raw.trim().split_once('/').ok_or_else(|| {
            SourcePolicyError::new(
                SourcePolicyCategory::InvalidLocator,
                "HTTP CIDR must include a prefix length",
            )
        })?;
        let network = address.parse::<IpAddr>().map_err(|_| {
            SourcePolicyError::new(
                SourcePolicyCategory::InvalidLocator,
                "HTTP CIDR has an invalid network address",
            )
        })?;
        let prefix = prefix.parse::<u8>().map_err(|_| {
            SourcePolicyError::new(
                SourcePolicyCategory::InvalidLocator,
                "HTTP CIDR has an invalid prefix length",
            )
        })?;
        let max = if network.is_ipv4() { 32 } else { 128 };
        if prefix > max {
            return Err(SourcePolicyError::new(
                SourcePolicyCategory::InvalidLocator,
                "HTTP CIDR prefix exceeds its address width",
            ));
        }
        Ok(Self { network, prefix })
    }

    fn contains(&self, address: IpAddr) -> bool {
        match (self.network, address) {
            (IpAddr::V4(network), IpAddr::V4(address)) => {
                let mask = if self.prefix == 0 {
                    0
                } else {
                    u32::MAX << (32 - self.prefix)
                };
                u32::from(network) & mask == u32::from(address) & mask
            }
            (IpAddr::V6(network), IpAddr::V6(address)) => {
                let mask = if self.prefix == 0 {
                    0
                } else {
                    u128::MAX << (128 - self.prefix)
                };
                u128::from(network) & mask == u128::from(address) & mask
            }
            _ => false,
        }
    }
}

fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_v4(address),
        IpAddr::V6(address) => is_public_v6(address),
    }
}

fn ipv6_in_prefix(address: Ipv6Addr, network: Ipv6Addr, prefix: u8) -> bool {
    debug_assert!(prefix <= 128);
    let mask = if prefix == 0 {
        0
    } else {
        u128::MAX << (128 - prefix)
    };
    u128::from(address) & mask == u128::from(network) & mask
}

fn is_embedded_or_transition_address(address: IpAddr) -> bool {
    let address = match address {
        IpAddr::V6(address) => address,
        IpAddr::V4(address) => {
            let octets = address.octets();
            // RFC 7050 NAT64 discovery answers and the deprecated 6to4 relay
            // anycast block remain structurally unsafe even under a broad
            // CIDR opt-in; neither is an intentional private/LAN endpoint.
            return (octets[..3] == [192, 0, 0] && matches!(octets[3], 170 | 171))
                || octets[..3] == [192, 88, 99];
        }
    };
    let segments = address.segments();

    // RFC 4291's deprecated IPv4-compatible form, IPv4-mapped addresses, and
    // RFC 6052's IPv4-translatable form. These embed an IPv4 destination in a
    // syntactically IPv6 address and must not inherit a hostname allowlist.
    let compatible = segments[..6] == [0, 0, 0, 0, 0, 0];
    let mapped = segments[..6] == [0, 0, 0, 0, 0, 0xffff];
    let translatable = segments[..6] == [0, 0, 0, 0, 0xffff, 0];

    // Standard translation/transition ranges. RFC 6052 also permits an
    // operator-selected network-specific prefix; deployments provide those
    // through `http_ipv6_translation_cidrs` because they cannot be inferred
    // from an address alone.
    let nat64_wkp = ipv6_in_prefix(address, Ipv6Addr::new(0x0064, 0xff9b, 0, 0, 0, 0, 0, 0), 96);
    let nat64_local = ipv6_in_prefix(address, Ipv6Addr::new(0x0064, 0xff9b, 1, 0, 0, 0, 0, 0), 48);
    let teredo = ipv6_in_prefix(address, Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 32);
    let six_to_four = segments[0] == 0x2002;
    let isatap = matches!(segments[4], 0x0000 | 0x0200) && segments[5] == 0x5efe;

    compatible
        || mapped
        || translatable
        || nat64_wkp
        || nat64_local
        || teredo
        || six_to_four
        || isatap
}

fn is_public_v4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    // IANA IPv4 Special-Purpose Address Registry (2025-10-09): protocol
    // assignments are non-global by default. The two exact anycast services
    // are the registry's only globally reachable exceptions in this /24.
    if octets[..3] == [192, 0, 0] {
        return matches!(octets[3], 9 | 10);
    }
    !(address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_broadcast()
        || address.is_documentation()
        || address.is_unspecified()
        || address.is_multicast()
        || octets[0] == 0
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 198 && (18..=19).contains(&octets[1]))
        || octets[..3] == [192, 88, 99]
        || octets[0] >= 240)
}

fn is_public_v6(address: Ipv6Addr) -> bool {
    if is_embedded_or_transition_address(IpAddr::V6(address)) {
        return false;
    }

    // IANA currently allocates global unicast from 2000::/3. Staying inside
    // that allocation prevents future/reserved top-level space from becoming
    // reachable merely because std adds no predicate for it.
    if !ipv6_in_prefix(address, Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3) {
        return false;
    }

    // IANA IPv6 Special-Purpose Address Registry (2025-10-09): 2001::/23 is
    // non-global by default. Keep its explicitly global suballocations
    // auditable here.
    if ipv6_in_prefix(address, Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23) {
        let exact_global = matches!(
            address,
            value if value == Ipv6Addr::new(0x2001, 1, 0, 0, 0, 0, 0, 1)
                || value == Ipv6Addr::new(0x2001, 1, 0, 0, 0, 0, 0, 2)
                || value == Ipv6Addr::new(0x2001, 1, 0, 0, 0, 0, 0, 3)
        );
        let global_suballocation = [
            (Ipv6Addr::new(0x2001, 0x0003, 0, 0, 0, 0, 0, 0), 32),
            (Ipv6Addr::new(0x2001, 0x0004, 0x0112, 0, 0, 0, 0, 0), 48),
            (Ipv6Addr::new(0x2001, 0x0020, 0, 0, 0, 0, 0, 0), 28),
            (Ipv6Addr::new(0x2001, 0x0030, 0, 0, 0, 0, 0, 0), 28),
        ]
        .into_iter()
        .any(|(network, prefix)| ipv6_in_prefix(address, network, prefix));
        return exact_global || global_suballocation;
    }

    // Documentation and returned/deprecated allocations inside 2000::/3.
    !ipv6_in_prefix(address, Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 0), 32)
        && !ipv6_in_prefix(address, Ipv6Addr::new(0x3ffe, 0, 0, 0, 0, 0, 0, 0), 16)
        && !ipv6_in_prefix(address, Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(config: SourceTrustConfig) -> SourceTrustPolicy {
        SourceTrustPolicy::from_config(config).unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_source_must_resolve_under_configured_root() {
        let root = tempfile::tempdir().unwrap();
        let inside = root.path().join("inside.zarr");
        std::fs::create_dir(&inside).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let policy = policy(SourceTrustConfig {
            local_roots: vec![root.path().to_path_buf()],
            ..SourceTrustConfig::default()
        });

        assert!(policy.admit(inside.to_str().unwrap()).await.is_ok());
        let error = policy
            .admit(outside.path().to_str().unwrap())
            .await
            .unwrap_err();
        assert_eq!(error.category, SourcePolicyCategory::LocalRootDenied);
        assert!(!error.to_string().contains(outside.path().to_str().unwrap()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn admitted_local_source_cannot_read_through_descendant_symlink() {
        use object_store::ObjectStoreExt;
        use object_store::path::Path as ObjectPath;
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let dataset = root.path().join("inside.zarr");
        std::fs::create_dir(&dataset).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.json"), b"outside").unwrap();
        symlink(
            outside.path().join("secret.json"),
            dataset.join("zarr.json"),
        )
        .unwrap();
        let policy = policy(SourceTrustConfig {
            local_roots: vec![root.path().to_path_buf()],
            ..SourceTrustConfig::default()
        });

        let admitted = policy.admit(dataset.to_str().unwrap()).await.unwrap();
        let backend = admitted.open_backend().unwrap();
        let error = backend
            .get(&ObjectPath::from("zarr.json"))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            object_store::Error::PermissionDenied { .. } | object_store::Error::NotFound { .. }
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn admitted_local_source_stays_pinned_after_dataset_path_becomes_escape_symlink() {
        use object_store::ObjectStoreExt;
        use object_store::path::Path as ObjectPath;
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let dataset = root.path().join("inside.zarr");
        let pinned_location = root.path().join("pinned-original.zarr");
        std::fs::create_dir(&dataset).unwrap();
        std::fs::write(dataset.join("zarr.json"), b"inside").unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("zarr.json"), b"outside").unwrap();
        let policy = policy(SourceTrustConfig {
            local_roots: vec![root.path().to_path_buf()],
            ..SourceTrustConfig::default()
        });

        // Admission pins the dataset directory descriptor. Replacing its path
        // afterward reproduces the former admit/open_backend TOCTOU exactly.
        let admitted = policy.admit(dataset.to_str().unwrap()).await.unwrap();
        std::fs::rename(&dataset, &pinned_location).unwrap();
        symlink(outside.path(), &dataset).unwrap();
        assert_eq!(
            std::fs::read(dataset.join("zarr.json")).unwrap(),
            b"outside"
        );

        let bytes = admitted
            .open_backend()
            .unwrap()
            .get(&ObjectPath::from("zarr.json"))
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert_eq!(&bytes[..], b"inside");
    }

    #[cfg(not(unix))]
    #[test]
    fn local_source_configuration_fails_closed_without_descriptor_confinement() {
        let root = tempfile::tempdir().unwrap();
        let error = SourceTrustPolicy::from_config(SourceTrustConfig {
            local_roots: vec![root.path().to_path_buf()],
            ..SourceTrustConfig::default()
        })
        .unwrap_err();
        assert_eq!(error.category, SourcePolicyCategory::InvalidLocator);
    }

    #[tokio::test]
    async fn loopback_and_metadata_targets_are_denied_even_for_allowed_host() {
        let policy = policy(SourceTrustConfig {
            http_hosts: vec!["127.0.0.1".into(), "169.254.169.254".into()],
            ..SourceTrustConfig::default()
        });
        for locator in [
            "http://127.0.0.1/data.zarr",
            "http://169.254.169.254/latest/meta-data",
        ] {
            let error = policy.admit(locator).await.unwrap_err();
            assert_eq!(error.category, SourcePolicyCategory::NetworkTargetDenied);
        }
    }

    #[tokio::test]
    async fn explicit_cidr_can_allow_an_intentional_private_service() {
        let policy = policy(SourceTrustConfig {
            http_cidrs: vec!["127.0.0.0/8".into()],
            ..SourceTrustConfig::default()
        });
        let admitted = policy
            .admit("http://127.0.0.1:8080/data.zarr")
            .await
            .unwrap();
        assert_eq!(admitted.redacted(), "http://127.0.0.1:8080/<redacted>");
    }

    #[tokio::test]
    async fn embedded_http_credentials_are_rejected_without_echoing_secrets() {
        let policy = policy(SourceTrustConfig {
            http_hosts: vec!["example.com".into()],
            ..SourceTrustConfig::default()
        });
        let error = policy
            .admit("https://alice:super-secret@example.com/data.zarr")
            .await
            .unwrap_err();
        assert_eq!(error.category, SourcePolicyCategory::InvalidLocator);
        assert!(!error.to_string().contains("alice"));
        assert!(!error.to_string().contains("super-secret"));
    }

    #[test]
    fn public_address_filter_covers_private_and_reserved_ranges() {
        for denied in [
            "0.0.0.1",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "192.168.1.1",
            "192.0.0.8",
            "192.0.0.11",
            "192.0.0.170",
            "192.0.0.171",
            "192.88.99.1",
            "192.88.99.2",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "fe80::1",
            "fc00::1",
            "2001:db8::1",
            "::8.8.8.8",
            "::ffff:8.8.8.8",
            "::ffff:0:8.8.8.8",
            "64:ff9b::808:808",
            "64:ff9b:1::808:808",
            "100::1",
            "2001::4136:e378:8000:63bf:3fff:fdd2",
            "2001:2::1",
            "2001:10::1",
            "2002:0808:0808::1",
            "2606:4700:4700:0:0:5efe:808:808",
            "3ffe::1",
            "3fff::1",
            "5f00::1",
        ] {
            assert!(!is_public_address(denied.parse().unwrap()), "{denied}");
        }
        for allowed in [
            "8.8.8.8",
            "192.0.0.9",
            "192.0.0.10",
            "192.31.196.1",
            "192.52.193.1",
            "192.175.48.1",
            "2001:1::1",
            "2001:3::1",
            "2001:4:112::1",
            "2001:20::1",
            "2001:30::1",
            "2001:4860:4860::8888",
            "2606:4700:4700::1111",
        ] {
            assert!(is_public_address(allowed.parse().unwrap()), "{allowed}");
        }
    }

    #[test]
    fn transition_addresses_are_rejected_before_any_pin_is_constructed() {
        let policy = policy(SourceTrustConfig {
            http_hosts: vec!["datasets.example".into()],
            // Even an explicit broad CIDR cannot opt standardized embedded or
            // transition forms back in.
            http_cidrs: vec!["0.0.0.0/0".into(), "::/0".into()],
            ..SourceTrustConfig::default()
        });
        for denied in [
            "::ffff:8.8.8.8",
            "::ffff:10.0.0.1",
            "::ffff:0:8.8.8.8",
            "::8.8.8.8",
            "64:ff9b::808:808",
            "64:ff9b:1::a00:1",
            "2001::4136:e378:8000:63bf:3fff:fdd2",
            "2002:0808:0808::1",
            "2606:4700:4700:0:200:5efe:808:808",
            "192.0.0.170",
            "192.0.0.171",
            "192.88.99.2",
        ] {
            let identity = SourceIdentity::parse("https://datasets.example/data.zarr").unwrap();
            let parsed = reqwest::Url::parse(identity.locator.as_str()).unwrap();
            let error = policy
                .admit_http_resolved(
                    identity,
                    parsed,
                    "datasets.example".into(),
                    vec![SocketAddr::new(denied.parse().unwrap(), 443)],
                )
                .unwrap_err();
            assert_eq!(
                error.category,
                SourcePolicyCategory::NetworkTargetDenied,
                "{denied}"
            );
        }
    }

    #[test]
    fn trailing_dot_http_host_is_rewritten_to_the_exact_dns_pin_key() {
        let policy = policy(SourceTrustConfig {
            http_hosts: vec!["datasets.example".into()],
            ..SourceTrustConfig::default()
        });
        let admit = |raw: &str| {
            let identity = SourceIdentity::parse(raw).unwrap();
            let parsed = reqwest::Url::parse(identity.locator.as_str()).unwrap();
            policy
                .admit_http_resolved(
                    identity,
                    parsed,
                    "datasets.example".into(),
                    vec![SocketAddr::new("8.8.8.8".parse().unwrap(), 443)],
                )
                .unwrap()
        };

        let dotted =
            admit("https://DATASETS.EXAMPLE./patient/data.zarr?access_token=transport-secret");
        let undotted =
            admit("https://datasets.example/patient/data.zarr?access_token=transport-secret");
        assert_eq!(dotted.identity, undotted.identity);
        assert_eq!(dotted.canonical_url(), undotted.canonical_url());
        assert_eq!(
            dotted.canonical_url(),
            "https://datasets.example/patient/data.zarr?access_token=transport-secret"
        );
        assert_eq!(dotted.redacted(), "https://datasets.example/<redacted>");
        assert!(!dotted.redacted().contains("transport-secret"));
        match &dotted.kind {
            AdmittedKind::Http {
                host, addresses, ..
            } => {
                let url = reqwest::Url::parse(dotted.canonical_url()).unwrap();
                assert_eq!(url.host_str(), Some(host.as_str()));
                assert_eq!(host, "datasets.example");
                assert_eq!(
                    addresses,
                    &[SocketAddr::new("8.8.8.8".parse().unwrap(), 443)]
                );
            }
            other => panic!("expected pinned HTTP transport, got {other:?}"),
        }
        dotted
            .open_backend()
            .expect("an exact URL host/pin key must build without DNS fallback");
    }

    #[test]
    fn deployment_translation_prefix_is_denied_while_neighboring_global_is_pinned() {
        let policy = policy(SourceTrustConfig {
            http_hosts: vec!["datasets.example".into()],
            http_cidrs: vec!["::/0".into()],
            http_ipv6_translation_cidrs: vec!["2606:4700:4700:100::/64".into()],
            ..SourceTrustConfig::default()
        });
        let resolve = |address: &str| {
            let identity = SourceIdentity::parse("https://datasets.example/data.zarr").unwrap();
            let parsed = reqwest::Url::parse(identity.locator.as_str()).unwrap();
            policy.admit_http_resolved(
                identity,
                parsed,
                "datasets.example".into(),
                vec![SocketAddr::new(address.parse().unwrap(), 443)],
            )
        };

        assert_eq!(
            resolve("2606:4700:4700:100::808:808").unwrap_err().category,
            SourcePolicyCategory::NetworkTargetDenied
        );
        let admitted = resolve("2606:4700:4700:101::1").unwrap();
        match admitted.kind {
            AdmittedKind::Http { addresses, .. } => assert_eq!(
                addresses,
                vec![SocketAddr::new(
                    "2606:4700:4700:101::1".parse().unwrap(),
                    443
                )]
            ),
            other => panic!("expected a pinned HTTP source, got {other:?}"),
        }
    }

    #[test]
    fn deployment_translation_prefix_configuration_requires_ipv6() {
        let error = SourceTrustPolicy::from_config(SourceTrustConfig {
            http_ipv6_translation_cidrs: vec!["192.0.2.0/24".into()],
            ..SourceTrustConfig::default()
        })
        .unwrap_err();
        assert_eq!(error.category, SourcePolicyCategory::InvalidLocator);
    }

    #[tokio::test]
    async fn cloud_buckets_require_explicit_scope_and_ambient_credential_opt_in() {
        let denied = policy(SourceTrustConfig {
            s3_buckets: vec!["images".into()],
            ..SourceTrustConfig::default()
        });
        assert_eq!(
            denied
                .admit("s3://images/data.zarr")
                .await
                .unwrap_err()
                .category,
            SourcePolicyCategory::CloudScopeDenied
        );

        let allowed = policy(SourceTrustConfig {
            s3_buckets: vec!["images".into()],
            allow_ambient_cloud_credentials: true,
            ..SourceTrustConfig::default()
        });
        assert!(allowed.admit("s3://images/data.zarr").await.is_ok());
        assert!(allowed.admit("s3://other/data.zarr").await.is_err());
    }

    #[test]
    fn untrusted_redaction_never_retains_credentials_or_object_paths() {
        let policy = SourceTrustPolicy::deny_all();
        let redacted = policy.redact_untrusted(
            "https://alice:super-secret@example.com/private/patient-42.zarr?token=also-secret",
        );
        assert_eq!(redacted, "https://example.com/<redacted>");
        for secret in ["alice", "super-secret", "patient-42", "also-secret"] {
            assert!(!redacted.contains(secret));
        }
    }
}
