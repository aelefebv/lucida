use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_FILE: AtomicU64 = AtomicU64::new(0);

/// Replace `path` atomically with a file that is private to the current user.
///
/// The temporary file lives beside the destination so the final rename cannot
/// cross filesystems. It is opened with `create_new` and mode 0600 before any
/// secret bytes are written, then both the file and its directory are synced.
pub fn write_private_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let mut last_collision = None;
    for _ in 0..32 {
        let temp_path = private_temp_path(path);
        match open_private_temp(&temp_path) {
            Ok(mut temp) => {
                let result = (|| {
                    temp.write_all(contents)?;
                    temp.sync_all()?;
                    #[cfg(unix)]
                    fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o600))?;
                    fs::rename(&temp_path, path)?;
                    sync_directory(parent)?;
                    Ok(())
                })();
                if result.is_err() {
                    let _ = fs::remove_file(&temp_path);
                }
                return result;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                last_collision = Some(error);
            }
            Err(error) => return Err(error),
        }
    }

    Err(last_collision.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate a private temporary file",
        )
    }))
}

fn private_temp_path(path: &Path) -> PathBuf {
    let sequence = NEXT_TEMP_FILE.fetch_add(1, Ordering::Relaxed);
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config");
    path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), sequence))
}

fn open_private_temp(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn test_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "lucida-secure-file-{name}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn atomically_replaces_existing_contents() {
        let path = test_path("replace");
        fs::write(&path, b"old").unwrap();

        write_private_atomic(&path, b"new").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new");
        let _ = fs::remove_file(path);
    }

    #[cfg(unix)]
    #[test]
    fn destination_is_private_even_when_replacing_a_public_file() {
        let path = test_path("mode");
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        write_private_atomic(&path, b"secret").unwrap();

        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = fs::remove_file(path);
    }
}
