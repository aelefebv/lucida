//! Where datasets may be opened from.
//!
//! An unrestricted policy opens any location. A restricted one opens local
//! paths only under the configured data roots, `http(s)` only from hosts
//! that resolve to public addresses unless allowlisted, and `gs://` and
//! `s3://` from any bucket unless a bucket allowlist is configured. What is
//! under a data root in a bucket opens either way.
//!
//! Addresses are judged twice: once when a location is opened, so a refusal
//! names its reason, and again by the resolver of every HTTP connection the
//! store makes, redirects included, so a name that later resolves elsewhere
//! is refused at connection time too.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use ipnet::IpNet;
use lucida_content::url::{DatasetLocation, LocationScheme};
use object_store::client::{ClientOptions, HttpClient, HttpConnector};

/// Redirects one HTTP read may follow, as many as reqwest's default.
const MAX_REDIRECTS: usize = 10;

/// What a source policy is built from.
#[derive(Debug, Clone, Default)]
pub struct SourcePolicyConfig {
    /// Apply the rules. When `false`, every location opens and the data
    /// roots only bound browsing.
    pub restricted: bool,
    /// Directories local datasets may be opened from.
    pub data_roots: Vec<PathBuf>,
    /// Data roots in buckets: `gs://bucket` or `s3://bucket` URLs, each
    /// with an optional prefix. What is under one opens even when the
    /// bucket allowlist leaves its bucket out.
    pub bucket_roots: Vec<String>,
    /// Hosts, IP addresses, or CIDR ranges an `http(s)` location may reach
    /// even when they are loopback, private, or link-local.
    pub allowed_hosts: Vec<String>,
    /// `gs://bucket` or `s3://bucket` entries. Empty allows every bucket.
    pub allowed_buckets: Vec<String>,
}

/// A configuration entry that does not parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourcePolicyError {
    DataRoot { root: String, reason: String },
    AllowedHost { entry: String },
    AllowedBucket { entry: String },
}

impl fmt::Display for SourcePolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SourcePolicyError::DataRoot { root, reason } => {
                write!(f, "data root {root}: {reason}")
            }
            SourcePolicyError::AllowedHost { entry } => write!(
                f,
                "allowed host {entry:?} is not a host name, an IP address, or a CIDR range"
            ),
            SourcePolicyError::AllowedBucket { entry } => write!(
                f,
                "allowed bucket {entry:?} is not a gs://bucket or s3://bucket URL"
            ),
        }
    }
}

impl std::error::Error for SourcePolicyError {}

/// Why a location may not be opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceDenied {
    /// A local path, on a server that configured no data directories.
    NoDataRoots { path: String },
    /// A local path outside every data directory.
    OutsideDataRoots { path: String },
    /// A host that is, or resolves to, a loopback, private, link-local, or
    /// otherwise non-public address, and is not allowlisted.
    RestrictedAddress { host: String, address: IpAddr },
    /// A bucket outside the bucket allowlist.
    BucketNotAllowed {
        scheme: &'static str,
        bucket: String,
    },
}

impl fmt::Display for SourceDenied {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SourceDenied::NoDataRoots { path } => write!(
                f,
                "local path {path} is not allowed: this server has no data directories configured"
            ),
            SourceDenied::OutsideDataRoots { path } => write!(
                f,
                "local path {path} is not allowed: it is outside the server's data directories"
            ),
            SourceDenied::RestrictedAddress { host, address } if host == &address.to_string() => {
                write!(
                    f,
                    "host {host} is not allowed: it is not a public address and is not on the allowed hosts list"
                )
            }
            SourceDenied::RestrictedAddress { host, address } => write!(
                f,
                "host {host} is not allowed: it resolves to {address}, which is not a public address and is not on the allowed hosts list"
            ),
            SourceDenied::BucketNotAllowed { scheme, bucket } => write!(
                f,
                "bucket {scheme}://{bucket} is not allowed: it is not on the allowed buckets list"
            ),
        }
    }
}

impl std::error::Error for SourceDenied {}

/// The configured rules for where datasets may be opened from.
#[derive(Debug, Clone, Default)]
pub struct SourcePolicy {
    restricted: bool,
    data_roots: Vec<DataRoot>,
    bucket_roots: Vec<BucketRoot>,
    addresses: Arc<AddressRules>,
    allowed_buckets: Vec<(LocationScheme, String)>,
}

impl SourcePolicy {
    /// A policy that opens every location.
    pub fn unrestricted() -> Self {
        Self::default()
    }

    /// Build a policy, skipping empty entries, which an empty environment
    /// variable produces.
    pub fn new(config: SourcePolicyConfig) -> Result<Self, SourcePolicyError> {
        let data_roots = config
            .data_roots
            .iter()
            .filter(|root| !root.as_os_str().is_empty())
            .map(|root| DataRoot::new(root))
            .collect::<Result<_, _>>()?;
        let bucket_roots = config
            .bucket_roots
            .iter()
            .filter(|entry| !entry.trim().is_empty())
            .map(|entry| BucketRoot::new(entry))
            .collect::<Result<_, _>>()?;
        let mut addresses = AddressRules::default();
        for entry in config.allowed_hosts.iter().filter(|e| !e.trim().is_empty()) {
            addresses.allow(entry)?;
        }
        let allowed_buckets = config
            .allowed_buckets
            .iter()
            .filter(|entry| !entry.trim().is_empty())
            .map(|entry| parse_bucket(entry))
            .collect::<Result<_, _>>()?;
        Ok(Self {
            restricted: config.restricted,
            data_roots,
            bucket_roots,
            addresses: Arc::new(addresses),
            allowed_buckets,
        })
    }

    pub fn is_restricted(&self) -> bool {
        self.restricted
    }

    /// The data roots in buckets, in canonical form.
    pub fn bucket_roots(&self) -> impl Iterator<Item = &DatasetLocation> {
        self.bucket_roots.iter().map(|root| &root.location)
    }

    /// The data roots on this machine, as configured and made absolute.
    pub fn data_roots(&self) -> impl Iterator<Item = &Path> {
        self.data_roots.iter().map(|root| root.configured.as_path())
    }

    /// Whether `/api/browse` may list `canonical`, a canonicalized
    /// directory. Configured data roots bound browsing in either mode; a
    /// restricted policy with none lists nothing.
    pub fn permits_browse(&self, canonical: &Path) -> bool {
        if self.data_roots.is_empty() {
            return !self.restricted;
        }
        self.data_roots
            .iter()
            .any(|root| root.holds_real(canonical))
    }

    /// Check `location` before it is opened.
    pub async fn check(&self, location: &DatasetLocation) -> Result<(), SourceDenied> {
        if !self.restricted {
            return Ok(());
        }
        match location.scheme() {
            LocationScheme::Local => self.check_local(location.as_str()).await,
            LocationScheme::Gcs | LocationScheme::S3 => self.check_bucket(location),
            LocationScheme::Http | LocationScheme::Https => {
                check_http(&self.addresses, location.as_str()).await
            }
        }
    }

    async fn check_local(&self, path: &str) -> Result<(), SourceDenied> {
        let denied = || {
            if self.data_roots.is_empty() {
                SourceDenied::NoDataRoots {
                    path: path.to_string(),
                }
            } else {
                SourceDenied::OutsideDataRoots {
                    path: path.to_string(),
                }
            }
        };
        // Judged by its spelling first, so a path outside every root is
        // refused without touching the filesystem or the network a UNC path
        // would reach.
        let segments = lexical_segments(path);
        if !self.data_roots.iter().any(|root| root.holds(&segments)) {
            return Err(denied());
        }
        // A path that exists is judged by where it really is, so a symlink
        // inside a root cannot lead out of it. One that does not exist fails
        // its open as a missing path.
        match tokio::fs::canonicalize(path).await {
            Ok(real) if self.data_roots.iter().any(|root| root.holds_real(&real)) => Ok(()),
            Ok(_) => Err(denied()),
            Err(_) => Ok(()),
        }
    }

    fn check_bucket(&self, location: &DatasetLocation) -> Result<(), SourceDenied> {
        if self.allowed_buckets.is_empty() {
            return Ok(());
        }
        let scheme = location.scheme();
        let bucket = location.bucket_name().unwrap_or_default();
        if self
            .allowed_buckets
            .iter()
            .any(|(s, b)| *s == scheme && b == bucket)
            || self.bucket_roots.iter().any(|root| root.holds(location))
        {
            return Ok(());
        }
        Err(SourceDenied::BucketNotAllowed {
            scheme: if scheme == LocationScheme::Gcs {
                "gs"
            } else {
                "s3"
            },
            bucket: bucket.to_string(),
        })
    }

    /// The connector every HTTP store of a restricted policy reads through,
    /// or `None` when the policy is unrestricted.
    pub(crate) fn http_connector(
        &self,
        allow_http: bool,
        timeout: Duration,
    ) -> Option<GuardedHttpConnector> {
        self.restricted.then(|| GuardedHttpConnector {
            addresses: Arc::clone(&self.addresses),
            allow_http,
            timeout,
        })
    }
}

/// One data root: its configured absolute form, the spellings of paths
/// under it, and where it really is when it exists.
#[derive(Debug, Clone)]
struct DataRoot {
    configured: PathBuf,
    /// The root as configured and, when it exists, as it really is, so a
    /// path spelled either way is judged under it.
    spellings: Vec<Vec<String>>,
    real: Option<PathBuf>,
}

impl DataRoot {
    fn new(root: &Path) -> Result<Self, SourcePolicyError> {
        let error = |reason: &str| SourcePolicyError::DataRoot {
            root: root.display().to_string(),
            reason: reason.to_string(),
        };
        let configured = std::path::absolute(root).map_err(|e| error(&e.to_string()))?;
        let text = configured
            .to_str()
            .ok_or_else(|| error("the path is not valid UTF-8"))?;
        let location = DatasetLocation::parse(text).map_err(|e| error(&e.to_string()))?;
        let real = std::fs::canonicalize(&configured).ok();
        let mut spellings = vec![lexical_segments(location.as_str())];
        if let Some(spelled) = real.as_deref().and_then(real_spelling) {
            spellings.push(lexical_segments(spelled.as_str()));
        }
        Ok(Self {
            configured,
            spellings,
            real,
        })
    }

    fn holds(&self, segments: &[String]) -> bool {
        self.spellings.iter().any(|root| {
            segments.len() >= root.len()
                && root
                    .iter()
                    .zip(segments)
                    .all(|(root, path)| same_segment(root, path))
        })
    }

    fn holds_real(&self, real: &Path) -> bool {
        self.real
            .as_ref()
            .is_some_and(|root| real.starts_with(root))
    }
}

/// A canonicalized path as a dataset location's canonical string, without
/// the `\\?\` prefix Windows puts on it.
fn real_spelling(real: &Path) -> Option<DatasetLocation> {
    let text = real.to_str()?;
    let unprefixed = match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => text.strip_prefix(r"\\?\").unwrap_or(text).to_string(),
    };
    DatasetLocation::parse(&unprefixed).ok()
}

/// A canonical local path as its root marker (`/`, `//` for UNC, or empty
/// before a drive letter) followed by its segments, with `.` dropped and
/// `..` applied.
fn lexical_segments(canonical: &str) -> Vec<String> {
    let marker = if canonical.starts_with("//") {
        "//"
    } else if canonical.starts_with('/') {
        "/"
    } else {
        ""
    };
    let mut segments = vec![marker.to_string()];
    for segment in canonical.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.len() > 1 {
                    segments.pop();
                }
            }
            other => segments.push(other.to_string()),
        }
    }
    segments
}

fn same_segment(a: &str, b: &str) -> bool {
    // Windows paths are case-insensitive, so `C:\Data` holds `c:/data/x`.
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

fn parse_bucket(entry: &str) -> Result<(LocationScheme, String), SourcePolicyError> {
    let error = || SourcePolicyError::AllowedBucket {
        entry: entry.to_string(),
    };
    let location = DatasetLocation::parse(entry.trim()).map_err(|_| error())?;
    match (
        location.scheme(),
        location.bucket_name(),
        location.object_prefix(),
    ) {
        (scheme @ (LocationScheme::Gcs | LocationScheme::S3), Some(bucket), None) => {
            Ok((scheme, bucket.to_string()))
        }
        _ => Err(error()),
    }
}

/// A data root in a bucket: its bucket and the key segments it holds.
#[derive(Debug, Clone)]
struct BucketRoot {
    location: DatasetLocation,
    scheme: LocationScheme,
    bucket: String,
    prefix: Vec<String>,
}

impl BucketRoot {
    fn new(entry: &str) -> Result<Self, SourcePolicyError> {
        let error = |reason: &str| SourcePolicyError::DataRoot {
            root: entry.to_string(),
            reason: reason.to_string(),
        };
        let location = DatasetLocation::parse(entry.trim()).map_err(|e| error(&e.to_string()))?;
        let (scheme @ (LocationScheme::Gcs | LocationScheme::S3), Some(bucket)) =
            (location.scheme(), location.bucket_name())
        else {
            return Err(error("it is not a gs:// or s3:// URL"));
        };
        let bucket = bucket.to_string();
        let prefix = key_segments(location.object_prefix())
            .ok_or_else(|| error("its prefix has a . or .. segment"))?;
        Ok(Self {
            location,
            scheme,
            bucket,
            prefix,
        })
    }

    fn holds(&self, location: &DatasetLocation) -> bool {
        location.scheme() == self.scheme
            && location.bucket_name() == Some(self.bucket.as_str())
            && key_segments(location.object_prefix())
                .is_some_and(|key| key.starts_with(&self.prefix))
    }
}

/// An object key's segments without the empty ones, which a store drops
/// too. `None` when one is `.` or `..`: a store reads those as literal
/// keys, but a reader of the URL takes them to leave the prefix, so no
/// bucket root holds such a key.
fn key_segments(key: Option<&str>) -> Option<Vec<String>> {
    let mut segments = Vec::new();
    for segment in key.unwrap_or_default().split('/') {
        match segment {
            "" => {}
            "." | ".." => return None,
            other => segments.push(other.to_string()),
        }
    }
    Some(segments)
}

/// The hosts and address ranges an HTTP source may reach although they are
/// not public.
#[derive(Debug, Default)]
struct AddressRules {
    hosts: Vec<String>,
    nets: Vec<IpNet>,
}

impl AddressRules {
    fn allow(&mut self, entry: &str) -> Result<(), SourcePolicyError> {
        let entry = entry.trim();
        let bare = entry.trim_start_matches('[').trim_end_matches(']');
        if let Ok(net) = IpNet::from_str(bare) {
            self.nets.push(net);
        } else if let Ok(address) = IpAddr::from_str(bare) {
            self.nets.push(IpNet::from(address));
        } else if !entry.is_empty()
            && entry
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
        {
            self.hosts.push(entry.to_ascii_lowercase());
        } else {
            return Err(SourcePolicyError::AllowedHost {
                entry: entry.to_string(),
            });
        }
        Ok(())
    }

    fn allows_host(&self, host: &str) -> bool {
        let host = host.trim_end_matches('.');
        self.hosts.iter().any(|h| h.eq_ignore_ascii_case(host))
    }

    fn allows_address(&self, address: IpAddr) -> bool {
        self.nets.iter().any(|net| net.contains(&address)) || is_public(address)
    }

    /// The first of `addresses` that `host` may not reach.
    fn first_denied(&self, host: &str, addresses: &[IpAddr]) -> Option<SourceDenied> {
        if self.allows_host(host) {
            return None;
        }
        addresses
            .iter()
            .find(|address| !self.allows_address(**address))
            .map(|address| SourceDenied::RestrictedAddress {
                host: host.to_string(),
                address: *address,
            })
    }

    /// Why a URL's host, when it is an IP address, may not be reached. A
    /// host name is left to the resolver, which sees every connection.
    fn literal_denied(&self, url: &reqwest::Url) -> Option<SourceDenied> {
        let address = match url.host()? {
            url::Host::Ipv4(v4) => IpAddr::V4(v4),
            url::Host::Ipv6(v6) => IpAddr::V6(v6),
            url::Host::Domain(_) => return None,
        };
        self.first_denied(&address.to_string(), &[address])
    }
}

async fn check_http(rules: &AddressRules, url: &str) -> Result<(), SourceDenied> {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return Ok(());
    };
    if let Some(denied) = rules.literal_denied(&parsed) {
        return Err(denied);
    }
    let Some(url::Host::Domain(host)) = parsed.host() else {
        return Ok(());
    };
    let port = parsed.port_or_known_default().unwrap_or(0);
    // A name that does not resolve now is left to fail its connection,
    // which the resolver checks again.
    let Ok(resolved) = tokio::net::lookup_host((host, port)).await else {
        return Ok(());
    };
    let addresses: Vec<IpAddr> = resolved.map(|socket| socket.ip()).collect();
    match rules.first_denied(host, &addresses) {
        Some(denied) => Err(denied),
        None => Ok(()),
    }
}

/// `true` for an address on the public internet: not loopback, private,
/// link-local (which holds the cloud metadata endpoints), shared, or
/// otherwise special-purpose.
fn is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(v4: Ipv4Addr) -> bool {
    let [a, b, c, _] = v4.octets();
    let shared = a == 100 && (64..128).contains(&b);
    let this_network = a == 0;
    let protocol_assignments = a == 192 && b == 0 && c == 0;
    !(v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_multicast()
        || shared
        || this_network
        || protocol_assignments)
}

fn is_public_v6(v6: Ipv6Addr) -> bool {
    // An IPv4 address carried in IPv6 is judged as IPv4.
    if let Some(v4) = v6.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let s = v6.segments();
    let nat64 = s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0];
    if nat64 {
        let [a, b] = s[6].to_be_bytes();
        let [c, d] = s[7].to_be_bytes();
        return is_public_v4(Ipv4Addr::new(a, b, c, d));
    }
    let unique_local = s[0] & 0xfe00 == 0xfc00;
    let link_local = s[0] & 0xffc0 == 0xfe80;
    let site_local = s[0] & 0xffc0 == 0xfec0;
    !(v6.is_loopback()
        || v6.is_unspecified()
        || v6.is_multicast()
        || unique_local
        || link_local
        || site_local)
}

/// An [`HttpConnector`] whose client resolves names through the policy and
/// re-checks every redirect, so no connection of an HTTP store reaches an
/// address the policy refuses.
#[derive(Debug)]
pub(crate) struct GuardedHttpConnector {
    addresses: Arc<AddressRules>,
    allow_http: bool,
    timeout: Duration,
}

impl HttpConnector for GuardedHttpConnector {
    fn connect(&self, _options: &ClientOptions) -> object_store::Result<HttpClient> {
        let redirects = Arc::clone(&self.addresses);
        let client = reqwest::Client::builder()
            .dns_resolver(Arc::new(GuardedResolver(Arc::clone(&self.addresses))))
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= MAX_REDIRECTS {
                    return attempt.error("too many redirects");
                }
                match redirects.literal_denied(attempt.url()) {
                    Some(denied) => attempt.error(denied),
                    None => attempt.follow(),
                }
            }))
            // A proxy would resolve names itself, out of the resolver's sight.
            .no_proxy()
            .timeout(self.timeout)
            .https_only(!self.allow_http)
            // Compression would hide the `Content-Length` object sizes come
            // from, as object_store's own client notes.
            .no_gzip()
            .no_brotli()
            .no_zstd()
            .no_deflate()
            .build()
            .map_err(|e| object_store::Error::Generic {
                store: "HTTP",
                source: Box::new(e),
            })?;
        Ok(HttpClient::new(client))
    }
}

struct GuardedResolver(Arc<AddressRules>);

impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let rules = Arc::clone(&self.0);
        let host = name.as_str().to_string();
        Box::pin(async move {
            let resolved: Vec<SocketAddr> =
                tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let addresses: Vec<IpAddr> = resolved.iter().map(SocketAddr::ip).collect();
            if let Some(denied) = rules.first_denied(&host, &addresses) {
                return Err(Box::new(denied) as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(resolved.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{StoreError, open_permitted};
    use object_store::{ObjectStore, ObjectStoreExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn location(raw: &str) -> DatasetLocation {
        DatasetLocation::parse(raw).unwrap()
    }

    fn path_location(path: &Path) -> DatasetLocation {
        location(path.to_str().unwrap())
    }

    fn restricted(config: SourcePolicyConfig) -> SourcePolicy {
        SourcePolicy::new(SourcePolicyConfig {
            restricted: true,
            ..config
        })
        .unwrap()
    }

    fn rooted(root: &Path) -> SourcePolicy {
        restricted(SourcePolicyConfig {
            data_roots: vec![root.to_path_buf()],
            ..Default::default()
        })
    }

    #[tokio::test]
    async fn an_unrestricted_policy_opens_every_location() {
        let policy = SourcePolicy::unrestricted();
        for raw in [
            "/srv/a.zarr",
            "c:/data/a.zarr",
            "http://127.0.0.1:8080/a.zarr",
            "http://169.254.169.254/a",
            "gs://any-bucket/a.zarr",
        ] {
            assert_eq!(policy.check(&location(raw)).await, Ok(()), "{raw}");
        }
    }

    #[tokio::test]
    async fn a_restricted_policy_without_data_roots_opens_no_local_path() {
        let tmp = tempfile::tempdir().unwrap();
        let policy = restricted(SourcePolicyConfig::default());
        let err = policy.check(&path_location(tmp.path())).await.unwrap_err();
        assert!(matches!(err, SourceDenied::NoDataRoots { .. }), "{err:?}");
        assert!(err.to_string().contains("no data directories"), "{err}");
    }

    #[tokio::test]
    async fn a_local_path_opens_only_under_a_data_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("data");
        let inside = root.join("a.zarr");
        let sibling = tmp.path().join("data2").join("a.zarr");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let policy = rooted(&root);

        assert_eq!(policy.check(&path_location(&inside)).await, Ok(()));
        // A missing path under a root is left to fail as missing.
        assert_eq!(
            policy
                .check(&path_location(&root.join("missing.zarr")))
                .await,
            Ok(())
        );
        for outside in [
            sibling.clone(),
            tmp.path().to_path_buf(),
            root.join("..").join("data2").join("a.zarr"),
        ] {
            let err = policy.check(&path_location(&outside)).await.unwrap_err();
            assert!(
                matches!(err, SourceDenied::OutsideDataRoots { .. }),
                "{outside:?}: {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn any_of_several_data_roots_holds_a_path() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let policy = restricted(SourcePolicyConfig {
            data_roots: vec![a.clone(), b.clone()],
            ..Default::default()
        });
        assert_eq!(policy.check(&path_location(&a)).await, Ok(()));
        assert_eq!(
            policy.check(&path_location(&b.join("x.zarr"))).await,
            Ok(())
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_symlink_cannot_lead_out_of_a_data_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("data");
        let elsewhere = tmp.path().join("elsewhere");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join("link")).unwrap();
        let err = rooted(&root)
            .check(&path_location(&root.join("link")))
            .await
            .unwrap_err();
        assert!(
            matches!(err, SourceDenied::OutsideDataRoots { .. }),
            "{err:?}"
        );
    }

    /// A root configured through a symlink holds paths spelled through the
    /// link and paths spelled as they really are.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_data_root_holds_both_spellings_of_its_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("data");
        std::fs::create_dir_all(real.join("a.zarr")).unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let policy = rooted(&link);
        assert_eq!(
            policy.check(&path_location(&link.join("a.zarr"))).await,
            Ok(())
        );
        let real = std::fs::canonicalize(&real).unwrap();
        assert_eq!(
            policy.check(&path_location(&real.join("a.zarr"))).await,
            Ok(())
        );
    }

    #[tokio::test]
    async fn http_to_a_non_public_address_is_refused() {
        let policy = restricted(SourcePolicyConfig::default());
        for raw in [
            "http://127.0.0.1:8080/a.zarr",
            "http://127.1.2.3/a.zarr",
            "http://10.0.0.5/a.zarr",
            "http://172.16.0.1/a.zarr",
            "http://192.168.1.20:9000/a.zarr",
            "http://169.254.169.254/computeMetadata/v1/",
            "http://100.64.0.1/a.zarr",
            "http://0.0.0.0/a.zarr",
            "http://[::1]/a.zarr",
            "http://[fd00:ec2::254]/a.zarr",
            "http://[fe80::1]/a.zarr",
            "http://[::ffff:10.0.0.1]/a.zarr",
            "http://[64:ff9b::a00:1]/a.zarr",
            "https://localhost/a.zarr",
        ] {
            let err = policy.check(&location(raw)).await.unwrap_err();
            assert!(
                matches!(err, SourceDenied::RestrictedAddress { .. }),
                "{raw}: {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn http_to_a_public_address_opens() {
        let policy = restricted(SourcePolicyConfig::default());
        for raw in [
            "https://93.184.215.14/a.zarr",
            "http://8.8.8.8:8080/a.zarr",
            "https://[2606:4700:4700::1111]/a.zarr",
        ] {
            assert_eq!(policy.check(&location(raw)).await, Ok(()), "{raw}");
        }
    }

    #[tokio::test]
    async fn allowlisted_hosts_and_ranges_are_reachable() {
        let policy = restricted(SourcePolicyConfig {
            allowed_hosts: vec![
                "localhost".into(),
                "10.0.0.0/8".into(),
                "[fd00::7]".into(),
                "192.168.1.20".into(),
            ],
            ..Default::default()
        });
        for raw in [
            "http://localhost:8080/a.zarr",
            "http://10.1.2.3/a.zarr",
            "http://[fd00::7]/a.zarr",
            "http://192.168.1.20:9000/a.zarr",
        ] {
            assert_eq!(policy.check(&location(raw)).await, Ok(()), "{raw}");
        }
        let err = policy
            .check(&location("http://192.168.1.21/a.zarr"))
            .await
            .unwrap_err();
        assert!(matches!(err, SourceDenied::RestrictedAddress { .. }));
    }

    #[test]
    fn a_name_resolving_to_any_non_public_address_is_refused() {
        let mut rules = AddressRules::default();
        rules.allow("trusted.internal").unwrap();
        let public: IpAddr = "93.184.215.14".parse().unwrap();
        let private: IpAddr = "10.0.0.1".parse().unwrap();
        assert_eq!(rules.first_denied("data.example", &[public]), None);
        assert_eq!(
            rules.first_denied("data.example", &[public, private]),
            Some(SourceDenied::RestrictedAddress {
                host: "data.example".into(),
                address: private,
            })
        );
        assert_eq!(rules.first_denied("Trusted.Internal.", &[private]), None);
    }

    #[tokio::test]
    async fn a_bucket_allowlist_limits_gs_and_s3() {
        let open = restricted(SourcePolicyConfig::default());
        assert_eq!(open.check(&location("gs://any/a.zarr")).await, Ok(()));
        assert_eq!(open.check(&location("s3://any/a.zarr")).await, Ok(()));

        let listed = restricted(SourcePolicyConfig {
            allowed_buckets: vec!["gs://team-data".into(), "S3://archive".into()],
            ..Default::default()
        });
        assert_eq!(
            listed.check(&location("gs://team-data/a.zarr")).await,
            Ok(())
        );
        assert_eq!(listed.check(&location("s3://archive")).await, Ok(()));
        for raw in [
            "gs://archive/a.zarr",
            "s3://team-data/a.zarr",
            "gs://other/a",
        ] {
            let err = listed.check(&location(raw)).await.unwrap_err();
            assert!(
                matches!(err, SourceDenied::BucketNotAllowed { .. }),
                "{raw}: {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn what_is_under_a_bucket_root_opens_past_the_bucket_allowlist() {
        let policy = restricted(SourcePolicyConfig {
            allowed_buckets: vec!["gs://team-data".into()],
            bucket_roots: vec!["gs://shared/images".into(), "S3://archive".into()],
            ..Default::default()
        });
        for raw in [
            "gs://shared/images",
            "gs://shared/images/",
            "gs://shared/images/runs/a.zarr",
            "gs://shared//images/a.zarr",
            "s3://archive/any/b.zarr",
            "gs://team-data/c.zarr",
        ] {
            assert_eq!(policy.check(&location(raw)).await, Ok(()), "{raw}");
        }
        for raw in [
            "gs://shared",
            "gs://shared/other/a.zarr",
            "gs://shared/images2/a.zarr",
            "gs://shared/images/../other/a.zarr",
            "s3://shared/images/a.zarr",
            "gs://archive/b.zarr",
            "gs://elsewhere/a.zarr",
        ] {
            let err = policy.check(&location(raw)).await.unwrap_err();
            assert!(
                matches!(err, SourceDenied::BucketNotAllowed { .. }),
                "{raw}: {err:?}"
            );
        }
        let store = open_permitted(&location("gs://shared/images/a.zarr"), &policy).await;
        assert!(store.is_ok(), "{:?}", store.err());
    }

    /// Without an allowlist every bucket opens, so a bucket root must not
    /// start refusing the buckets outside it.
    #[tokio::test]
    async fn bucket_roots_leave_other_buckets_to_the_allowlist() {
        let policy = restricted(SourcePolicyConfig {
            bucket_roots: vec!["gs://shared/images".into()],
            ..Default::default()
        });
        for raw in [
            "gs://shared/other/a.zarr",
            "gs://elsewhere/a.zarr",
            "s3://any/a.zarr",
        ] {
            assert_eq!(policy.check(&location(raw)).await, Ok(()), "{raw}");
        }
    }

    #[test]
    fn bucket_roots_are_canonical_and_bad_ones_are_named() {
        let policy = SourcePolicy::new(SourcePolicyConfig {
            bucket_roots: vec![
                "GS://shared/images".into(),
                " ".into(),
                "s3://archive".into(),
            ],
            ..Default::default()
        })
        .unwrap();
        let roots: Vec<_> = policy.bucket_roots().map(DatasetLocation::as_str).collect();
        assert_eq!(roots, ["gs://shared/images", "s3://archive"]);
        assert_eq!(policy.data_roots().count(), 0);

        for entry in [
            "gs://",
            "https://host/data",
            "/srv/data",
            "gs://shared/a/../b",
        ] {
            let err = SourcePolicy::new(SourcePolicyConfig {
                bucket_roots: vec![entry.into()],
                ..Default::default()
            })
            .unwrap_err();
            assert!(
                matches!(&err, SourcePolicyError::DataRoot { root, .. } if root == entry),
                "{entry}: {err:?}"
            );
        }
    }

    /// The setup a deployment behind an authenticating perimeter runs:
    /// a restricted policy and nothing else configured. Buckets read with
    /// the server's own credentials and public `https` still open.
    #[tokio::test]
    async fn a_restricted_policy_with_nothing_configured_opens_buckets_and_public_https() {
        let policy = restricted(SourcePolicyConfig::default());
        for raw in [
            "gs://team-bucket/datasets/a.ome.zarr",
            "s3://team-bucket/a.ome.zarr",
            "https://93.184.215.14/a.ome.zarr",
        ] {
            let store = open_permitted(&location(raw), &policy).await;
            assert!(store.is_ok(), "{raw}: {:?}", store.err());
        }
        let local = open_permitted(&location("/srv/a.zarr"), &policy).await;
        assert!(matches!(local, Err(StoreError::Denied(_))));
    }

    #[test]
    fn browsing_follows_the_data_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("data");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        let real_root = std::fs::canonicalize(&root).unwrap();
        let real_tmp = std::fs::canonicalize(tmp.path()).unwrap();

        assert!(SourcePolicy::unrestricted().permits_browse(&real_tmp));
        assert!(!restricted(SourcePolicyConfig::default()).permits_browse(&real_tmp));
        for policy in [
            rooted(&root),
            SourcePolicy::new(SourcePolicyConfig {
                data_roots: vec![root.clone()],
                ..Default::default()
            })
            .unwrap(),
        ] {
            assert!(policy.permits_browse(&real_root.join("sub")));
            assert!(!policy.permits_browse(&real_tmp));
        }
    }

    #[test]
    fn configuration_entries_that_do_not_parse_are_named() {
        let host = SourcePolicy::new(SourcePolicyConfig {
            allowed_hosts: vec!["not a host".into()],
            ..Default::default()
        })
        .unwrap_err();
        assert_eq!(
            host,
            SourcePolicyError::AllowedHost {
                entry: "not a host".into()
            }
        );
        for entry in ["gs://bucket/prefix", "https://host", "bucket"] {
            let bucket = SourcePolicy::new(SourcePolicyConfig {
                allowed_buckets: vec![entry.into()],
                ..Default::default()
            })
            .unwrap_err();
            assert!(
                matches!(bucket, SourcePolicyError::AllowedBucket { .. }),
                "{entry}"
            );
        }
    }

    /// A tiny HTTP server on loopback: `/ok/…` answers `{}` and
    /// `/redirect/…` redirects to `target` with the same tail.
    async fn serve(target: impl Fn(u16) -> String + Send + Sync + 'static) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let target = Arc::new(target);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let target = Arc::clone(&target);
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]);
                    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let response = match path.strip_prefix("/redirect/") {
                        Some(tail) => format!(
                            "HTTP/1.1 302 Found\r\nLocation: {}/ok/{tail}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            target(port)
                        ),
                        None => "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nLast-Modified: Thu, 01 Jan 2026 00:00:00 GMT\r\nConnection: close\r\n\r\n{}".to_string(),
                    };
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        port
    }

    async fn read_zarr_json(store: &Arc<dyn ObjectStore>) -> object_store::Result<bytes::Bytes> {
        store
            .get(&object_store::path::Path::from("zarr.json"))
            .await?
            .bytes()
            .await
    }

    #[tokio::test]
    async fn a_redirect_to_a_non_public_address_is_refused() {
        // 127.0.0.2 is loopback too, but not the allowlisted address.
        let port = serve(|port| format!("http://127.0.0.2:{port}")).await;
        let policy = restricted(SourcePolicyConfig {
            allowed_hosts: vec!["127.0.0.1".into()],
            ..Default::default()
        });

        let direct = open_permitted(&location(&format!("http://127.0.0.1:{port}/ok")), &policy)
            .await
            .unwrap();
        assert_eq!(read_zarr_json(&direct).await.unwrap().as_ref(), b"{}");

        let redirected = open_permitted(
            &location(&format!("http://127.0.0.1:{port}/redirect")),
            &policy,
        )
        .await
        .unwrap();
        let err = read_zarr_json(&redirected).await.unwrap_err();
        assert_eq!(
            denial_in(&err),
            Some(SourceDenied::RestrictedAddress {
                host: "127.0.0.2".into(),
                address: "127.0.0.2".parse().unwrap(),
            }),
            "{err}"
        );
    }

    /// The policy refusal somewhere in `err`'s source chain.
    fn denial_in(err: &(dyn std::error::Error + 'static)) -> Option<SourceDenied> {
        let mut next = Some(err);
        while let Some(err) = next {
            if let Some(denied) = err.downcast_ref::<SourceDenied>() {
                return Some(denied.clone());
            }
            next = err.source();
        }
        None
    }

    #[tokio::test]
    async fn every_connection_resolves_through_the_policy() {
        let port = serve(|port| format!("http://127.0.0.1:{port}")).await;
        let url = format!("http://localhost:{port}/ok");

        // Built past the open-time check, so only the resolver stands
        // between the store and the address.
        let guarded = |hosts: Vec<String>| {
            let policy = restricted(SourcePolicyConfig {
                allowed_hosts: hosts,
                ..Default::default()
            });
            let connector = policy.http_connector(true, Duration::from_secs(5));
            crate::backend::http_store(&url, true, connector).unwrap()
        };
        let refused = guarded(vec![]);
        let err = read_zarr_json(&refused).await.unwrap_err();
        assert!(
            matches!(
                denial_in(&err),
                Some(SourceDenied::RestrictedAddress { ref host, .. }) if host == "localhost"
            ),
            "{err}"
        );

        let allowed = guarded(vec!["localhost".into()]);
        assert_eq!(read_zarr_json(&allowed).await.unwrap().as_ref(), b"{}");
    }
}
