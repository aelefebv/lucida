use std::env;
use std::path::{Component, Path, PathBuf};

use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use sha2::{Digest, Sha256};

const FILE_URI_PATH_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}');

pub fn normalize_uri(uri: &str) -> String {
    if let Some((scheme, _rest)) = split_scheme(uri) {
        if scheme.eq_ignore_ascii_case("file") {
            return normalize_file_uri(uri);
        }
        return uri.to_owned();
    }
    normalize_local_path(uri)
}

pub fn is_remote_uri(uri: &str) -> bool {
    if let Some((scheme, _)) = split_scheme(uri) {
        !scheme.eq_ignore_ascii_case("file")
    } else {
        false
    }
}

pub fn generate_dataset_id(normalized_uri: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(normalized_uri.as_bytes());
    let digest = hasher.finalize();
    let hex = format!("{digest:x}");
    format!("ds_{}", &hex[..16])
}

pub fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    if let Some((scheme, rest)) = split_scheme(uri) {
        if !scheme.eq_ignore_ascii_case("file") {
            return None;
        }
        return Some(file_uri_path_to_path(rest));
    }
    Some(PathBuf::from(uri))
}

fn normalize_file_uri(uri: &str) -> String {
    let path = if let Some(rest) = uri.strip_prefix("file://") {
        let path_part = if rest.starts_with('/') {
            rest
        } else if let Some(index) = rest.find('/') {
            &rest[index..]
        } else {
            ""
        };
        decode_path_part(path_part)
    } else if let Some(rest) = uri.strip_prefix("file:") {
        decode_path_part(rest)
    } else if let Some((_, rest)) = split_scheme(uri) {
        decode_path_part(rest)
    } else {
        decode_path_part(uri)
    };
    normalize_local_path(&path)
}

fn file_uri_path_to_path(rest: &str) -> PathBuf {
    let decoded = if rest.starts_with("//") {
        let without_scheme = &rest[2..];
        if without_scheme.starts_with('/') {
            decode_path_part(without_scheme)
        } else if let Some(index) = without_scheme.find('/') {
            decode_path_part(&without_scheme[index..])
        } else {
            String::new()
        }
    } else {
        decode_path_part(rest)
    };
    PathBuf::from(decoded)
}

fn normalize_local_path(raw_path: &str) -> String {
    let expanded = expand_user(raw_path);
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        cwd.join(expanded)
    };
    let normalized = normalize_path_components(&absolute);
    format!("file://{}", encode_path_for_uri(&normalized))
}

fn expand_user(raw_path: &str) -> PathBuf {
    if raw_path == "~" {
        if let Some(home) = env::var_os("HOME") {
            return PathBuf::from(home);
        }
    }
    if let Some(rest) = raw_path.strip_prefix("~/") {
        if let Some(home) = env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(raw_path)
}

fn normalize_path_components(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(segment) => normalized.push(segment),
        }
    }
    if normalized.as_os_str().is_empty() {
        PathBuf::from("/")
    } else {
        normalized
    }
}

fn encode_path_for_uri(path: &Path) -> String {
    utf8_percent_encode(path.to_string_lossy().as_ref(), FILE_URI_PATH_ENCODE_SET).to_string()
}

fn decode_path_part(path_part: &str) -> String {
    let mut candidate = path_part;
    if let Some(index) = candidate.find('#') {
        candidate = &candidate[..index];
    }
    if let Some(index) = candidate.find('?') {
        candidate = &candidate[..index];
    }
    percent_decode_str(candidate)
        .decode_utf8_lossy()
        .to_string()
}

fn split_scheme(uri: &str) -> Option<(&str, &str)> {
    let mut chars = uri.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let colon_index = uri.find(':')?;
    if colon_index == 0 {
        return None;
    }
    let scheme = &uri[..colon_index];
    if !scheme
        .chars()
        .all(|value| value.is_ascii_alphanumeric() || matches!(value, '+' | '-' | '.'))
    {
        return None;
    }
    Some((scheme, &uri[colon_index + 1..]))
}
