use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::model::StabilityWindow;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchError {
    InvalidSourceUri { uri: String, message: String },
    SourceNotFound { uri: String },
    ReadFailed { uri: String, message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchSignature {
    pub entry_count: u64,
    pub total_bytes: u64,
    pub newest_modified_ms: u128,
    pub fingerprint: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchPoll {
    pub signature: WatchSignature,
    pub changed: bool,
}

pub trait SourceWatcher {
    fn poll(&mut self, uri: &str) -> Result<WatchPoll, WatchError>;
}

#[derive(Debug, Default)]
pub struct FileWatcher {
    last_signature: Option<WatchSignature>,
}

impl FileWatcher {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl SourceWatcher for FileWatcher {
    fn poll(&mut self, uri: &str) -> Result<WatchPoll, WatchError> {
        let path = source_path_from_uri(uri)?;
        let signature = file_signature(uri, &path)?;
        let changed = self.last_signature.as_ref() != Some(&signature);
        self.last_signature = Some(signature.clone());
        Ok(WatchPoll { signature, changed })
    }
}

#[derive(Debug, Default)]
pub struct DirectoryWatcher {
    last_signature: Option<WatchSignature>,
}

impl DirectoryWatcher {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl SourceWatcher for DirectoryWatcher {
    fn poll(&mut self, uri: &str) -> Result<WatchPoll, WatchError> {
        let path = source_path_from_uri(uri)?;
        let signature = directory_signature(uri, &path)?;
        let changed = self.last_signature.as_ref() != Some(&signature);
        self.last_signature = Some(signature.clone());
        Ok(WatchPoll { signature, changed })
    }
}

#[derive(Debug)]
pub enum SourceWatcherKind {
    File(FileWatcher),
    Directory(DirectoryWatcher),
}

impl SourceWatcherKind {
    pub fn poll(&mut self, uri: &str) -> Result<WatchPoll, WatchError> {
        match self {
            SourceWatcherKind::File(watcher) => watcher.poll(uri),
            SourceWatcherKind::Directory(watcher) => watcher.poll(uri),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StabilityWindowGate {
    change_detected_at_ms: Option<u64>,
    verify_due_at_ms: Option<u64>,
    verify_signature: Option<WatchSignature>,
}

impl StabilityWindowGate {
    #[must_use]
    pub fn new() -> Self {
        Self {
            change_detected_at_ms: None,
            verify_due_at_ms: None,
            verify_signature: None,
        }
    }

    pub fn note_change(&mut self, now_ms: u64, signature: WatchSignature) {
        self.change_detected_at_ms = Some(now_ms);
        self.verify_due_at_ms = None;
        self.verify_signature = Some(signature);
    }

    #[must_use]
    pub fn evaluate_stability(
        &mut self,
        now_ms: u64,
        observed_signature: &WatchSignature,
        window: &StabilityWindow,
    ) -> bool {
        let Some(change_detected_at_ms) = self.change_detected_at_ms else {
            return false;
        };

        let debounce_ms = u64::from(window.debounce_seconds) * 1000;
        if now_ms < change_detected_at_ms.saturating_add(debounce_ms) {
            return false;
        }

        let verify_delay_ms = u64::from(window.single_file_verify_ms);
        let due_at = if let Some(due) = self.verify_due_at_ms {
            due
        } else {
            let due = now_ms.saturating_add(verify_delay_ms);
            self.verify_due_at_ms = Some(due);
            self.verify_signature = Some(observed_signature.clone());
            due
        };

        if now_ms < due_at {
            return false;
        }

        if self.verify_signature.as_ref() == Some(observed_signature) {
            self.change_detected_at_ms = None;
            self.verify_due_at_ms = None;
            self.verify_signature = None;
            return true;
        }

        self.change_detected_at_ms = Some(now_ms);
        self.verify_due_at_ms = None;
        self.verify_signature = Some(observed_signature.clone());
        false
    }
}

impl Default for StabilityWindowGate {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug)]
pub struct SourceWatchController {
    watcher: SourceWatcherKind,
    gate: StabilityWindowGate,
}

impl SourceWatchController {
    pub fn from_uri(uri: &str) -> Result<Self, WatchError> {
        let path = source_path_from_uri(uri)?;
        let metadata = fs::metadata(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                WatchError::SourceNotFound {
                    uri: uri.to_owned(),
                }
            } else {
                WatchError::ReadFailed {
                    uri: uri.to_owned(),
                    message: error.to_string(),
                }
            }
        })?;

        let watcher = if metadata.is_dir() {
            SourceWatcherKind::Directory(DirectoryWatcher::new())
        } else {
            SourceWatcherKind::File(FileWatcher::new())
        };

        Ok(Self {
            watcher,
            gate: StabilityWindowGate::new(),
        })
    }

    pub fn poll_and_evaluate(
        &mut self,
        uri: &str,
        now_ms: u64,
        window: &StabilityWindow,
    ) -> Result<WatchDecision, WatchError> {
        let poll = self.watcher.poll(uri)?;
        if poll.changed {
            self.gate.note_change(now_ms, poll.signature.clone());
        }

        let stable_for_ingest = self
            .gate
            .evaluate_stability(now_ms, &poll.signature, window);
        Ok(WatchDecision {
            changed: poll.changed,
            stable_for_ingest,
            signature: poll.signature,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchDecision {
    pub changed: bool,
    pub stable_for_ingest: bool,
    pub signature: WatchSignature,
}

fn source_path_from_uri(uri: &str) -> Result<PathBuf, WatchError> {
    if let Some(raw_path) = uri.strip_prefix("file://") {
        if raw_path.is_empty() {
            return Err(WatchError::InvalidSourceUri {
                uri: uri.to_owned(),
                message: "file URI must include a path".to_owned(),
            });
        }

        if cfg!(windows) {
            Ok(PathBuf::from(raw_path.trim_start_matches('/')))
        } else {
            Ok(PathBuf::from(raw_path))
        }
    } else if uri.is_empty() {
        Err(WatchError::InvalidSourceUri {
            uri: uri.to_owned(),
            message: "source URI must not be empty".to_owned(),
        })
    } else {
        Ok(PathBuf::from(uri))
    }
}

fn file_signature(uri: &str, path: &Path) -> Result<WatchSignature, WatchError> {
    let metadata = fs::metadata(path).map_err(|error| WatchError::ReadFailed {
        uri: uri.to_owned(),
        message: error.to_string(),
    })?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis());
    let bytes = metadata.len();
    let fingerprint = bytes ^ (modified_ms as u64);
    Ok(WatchSignature {
        entry_count: 1,
        total_bytes: bytes,
        newest_modified_ms: modified_ms,
        fingerprint,
    })
}

fn directory_signature(uri: &str, root: &Path) -> Result<WatchSignature, WatchError> {
    let mut pending = vec![root.to_path_buf()];
    let mut seen = BTreeSet::new();
    let mut entry_count = 0_u64;
    let mut total_bytes = 0_u64;
    let mut newest_modified_ms = 0_u128;
    let mut fingerprint = 0_u64;

    while let Some(path) = pending.pop() {
        if !seen.insert(path.clone()) {
            continue;
        }

        let entries = fs::read_dir(&path).map_err(|error| WatchError::ReadFailed {
            uri: uri.to_owned(),
            message: error.to_string(),
        })?;

        for entry in entries {
            let entry = entry.map_err(|error| WatchError::ReadFailed {
                uri: uri.to_owned(),
                message: error.to_string(),
            })?;
            let child_path = entry.path();
            let child_metadata = entry.metadata().map_err(|error| WatchError::ReadFailed {
                uri: uri.to_owned(),
                message: error.to_string(),
            })?;

            if child_metadata.is_dir() {
                pending.push(child_path);
                continue;
            }

            entry_count = entry_count.saturating_add(1);
            total_bytes = total_bytes.saturating_add(child_metadata.len());
            let modified_ms = child_metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_millis());
            newest_modified_ms = newest_modified_ms.max(modified_ms);
            fingerprint ^= child_metadata.len() ^ (modified_ms as u64);
        }
    }

    Ok(WatchSignature {
        entry_count,
        total_bytes,
        newest_modified_ms,
        fingerprint,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{DirectoryWatcher, FileWatcher, SourceWatchController, SourceWatcher};
    use crate::model::StabilityWindow;

    fn unique_path(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lucida_luc201_{prefix}_{}_{}",
            std::process::id(),
            nanos
        ))
    }

    fn write_file(path: &std::path::Path, data: &[u8]) {
        fs::write(path, data).expect("fixture file write should succeed");
    }

    #[test]
    fn file_watcher_detects_changes() {
        let file_path = unique_path("file").with_extension("bin");
        write_file(&file_path, b"abc");

        let mut watcher = FileWatcher::new();
        let first = watcher
            .poll(&file_path.display().to_string())
            .expect("first poll should succeed");
        let second = watcher
            .poll(&file_path.display().to_string())
            .expect("second poll should succeed");
        write_file(&file_path, b"abcdef");
        let third = watcher
            .poll(&file_path.display().to_string())
            .expect("third poll should succeed");

        assert!(first.changed);
        assert!(!second.changed);
        assert!(third.changed);

        fs::remove_file(file_path).expect("fixture cleanup should succeed");
    }

    #[test]
    fn directory_watcher_detects_child_file_changes() {
        let dir_path = unique_path("dir");
        fs::create_dir_all(&dir_path).expect("fixture dir creation should succeed");
        let file_path = dir_path.join("a.bin");
        write_file(&file_path, b"abc");

        let mut watcher = DirectoryWatcher::new();
        let first = watcher
            .poll(&dir_path.display().to_string())
            .expect("first poll should succeed");
        let second = watcher
            .poll(&dir_path.display().to_string())
            .expect("second poll should succeed");
        write_file(&file_path, b"abcdef");
        let third = watcher
            .poll(&dir_path.display().to_string())
            .expect("third poll should succeed");

        assert!(first.changed);
        assert!(!second.changed);
        assert!(third.changed);

        fs::remove_dir_all(dir_path).expect("fixture cleanup should succeed");
    }

    #[test]
    fn stability_window_requires_debounce_and_quick_verify() {
        let file_path = unique_path("stability").with_extension("bin");
        write_file(&file_path, b"abc");

        let mut controller = SourceWatchController::from_uri(&file_path.display().to_string())
            .expect("watch controller creation should succeed");
        let window = StabilityWindow {
            debounce_seconds: 2,
            single_file_verify_ms: 200,
        };

        let first = controller
            .poll_and_evaluate(&file_path.display().to_string(), 0, &window)
            .expect("first poll should succeed");
        assert!(first.changed);
        assert!(!first.stable_for_ingest);

        write_file(&file_path, b"abcdef");
        let changed = controller
            .poll_and_evaluate(&file_path.display().to_string(), 1000, &window)
            .expect("change poll should succeed");
        assert!(changed.changed);
        assert!(!changed.stable_for_ingest);

        let before_debounce = controller
            .poll_and_evaluate(&file_path.display().to_string(), 2500, &window)
            .expect("before debounce poll should succeed");
        assert!(!before_debounce.stable_for_ingest);

        let start_verify = controller
            .poll_and_evaluate(&file_path.display().to_string(), 3000, &window)
            .expect("verify start poll should succeed");
        assert!(!start_verify.stable_for_ingest);

        let ready = controller
            .poll_and_evaluate(&file_path.display().to_string(), 3200, &window)
            .expect("ready poll should succeed");
        assert!(ready.stable_for_ingest);

        fs::remove_file(file_path).expect("fixture cleanup should succeed");
    }
}
