//! Filesystem permission setup for the process that owns the daemon.

use std::io;
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum FilesystemPermissionError {
    #[error("filesystem permission worker failed: {0}")]
    Worker(#[from] tokio::task::JoinError),
    #[error("cannot locate the current user's home directory for the Full Disk Access check")]
    HomeDirectoryUnavailable,
    #[error("cannot check Full Disk Access using {path}: {source}")]
    Probe {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("cannot open Full Disk Access settings: {0}")]
    OpenSettings(#[source] io::Error),
}

/// Check this process's filesystem access without opening macOS settings.
///
/// Returns `None` on other platforms. On macOS, `Some(false)` means the user must
/// enable Full Disk Access in System Settings.
///
/// macOS has no public Full Disk Access status API. This infers access by opening
/// the user's protected TCC database, falling back to the system database only if
/// the user database is absent. It never reads database contents. These paths are
/// not an Apple API, and filesystem permissions can also deny the probe, so a
/// successful check does not replace handling errors from actual file operations.
/// The probe runs inside the hosting process, including when loaded by Electron.
///
/// # Errors
/// Returns an error if neither protected file exists, another filesystem error
/// prevents the check, or the worker cannot complete.
pub async fn check_full_disk_access() -> Result<Option<bool>, FilesystemPermissionError> {
    #[cfg(target_os = "macos")]
    {
        Ok(Some(
            tokio::task::spawn_blocking(check_macos_full_disk_access).await??,
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

/// Check this process's filesystem access and open macOS settings if it is denied.
///
/// Uses the same protected-file probe as [`check_full_disk_access`]. Returns
/// `None` on other platforms. On macOS, `Some(false)` means the user must enable
/// Full Disk Access in System Settings; opening settings does not grant it.
///
/// # Errors
/// Returns an error if the permission probe fails, opening settings fails,
/// or the worker cannot complete.
pub async fn request_full_disk_access() -> Result<Option<bool>, FilesystemPermissionError> {
    #[cfg(target_os = "macos")]
    {
        Ok(Some(
            tokio::task::spawn_blocking(request_macos_full_disk_access).await??,
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
fn check_macos_full_disk_access() -> Result<bool, FilesystemPermissionError> {
    let home = std::env::home_dir().ok_or(FilesystemPermissionError::HomeDirectoryUnavailable)?;
    probe_full_disk_access(&home, |path| std::fs::File::open(path).map(drop))
}

#[cfg(target_os = "macos")]
fn request_macos_full_disk_access() -> Result<bool, FilesystemPermissionError> {
    let granted = check_macos_full_disk_access()?;
    if !granted {
        crate::permission_settings::open("Privacy_AllFiles")
            .map_err(FilesystemPermissionError::OpenSettings)?;
    }
    Ok(granted)
}

#[cfg(any(target_os = "macos", test))]
fn probe_full_disk_access(
    home: &std::path::Path,
    mut open: impl FnMut(&std::path::Path) -> io::Result<()>,
) -> Result<bool, FilesystemPermissionError> {
    let user_database = home.join("Library/Application Support/com.apple.TCC/TCC.db");
    match open(&user_database) {
        Ok(()) => return Ok(true),
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(FilesystemPermissionError::Probe {
                path: user_database,
                source,
            });
        }
    }

    let system_database = PathBuf::from("/Library/Application Support/com.apple.TCC/TCC.db");
    match open(&system_database) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => Ok(false),
        Err(source) => Err(FilesystemPermissionError::Probe {
            path: system_database,
            source,
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn missing_user_database_requires_successful_system_probe() {
        let mut checked = Vec::new();
        let granted = probe_full_disk_access(Path::new("/Users/test"), |path| {
            checked.push(path.to_path_buf());
            if checked.len() == 1 {
                Err(io::ErrorKind::NotFound.into())
            } else {
                Ok(())
            }
        })
        .expect("the system database can confirm access");

        assert!(granted);
        assert_eq!(
            checked,
            [
                PathBuf::from("/Users/test/Library/Application Support/com.apple.TCC/TCC.db"),
                PathBuf::from("/Library/Application Support/com.apple.TCC/TCC.db"),
            ],
        );
    }

    #[test]
    fn absent_protected_files_do_not_imply_permission() {
        let error = probe_full_disk_access(Path::new("/Users/test"), |_| {
            Err(io::ErrorKind::NotFound.into())
        })
        .expect_err("no protected file was opened");

        assert!(matches!(
            error,
            FilesystemPermissionError::Probe { source, .. }
                if source.kind() == io::ErrorKind::NotFound
        ));
    }

    #[test]
    fn denied_user_access_does_not_try_system_database() {
        let mut attempts = 0;
        let granted = probe_full_disk_access(Path::new("/Users/test"), |_| {
            attempts += 1;
            Err(io::ErrorKind::PermissionDenied.into())
        })
        .expect("a permission denial is a known result");

        assert!(!granted);
        assert_eq!(attempts, 1);
    }

    #[test]
    fn unexpected_probe_errors_preserve_their_cause() {
        let error = probe_full_disk_access(Path::new("/Users/test"), |_| {
            Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "probe interrupted",
            ))
        })
        .expect_err("an I/O failure is not a permission decision");

        assert!(matches!(
            error,
            FilesystemPermissionError::Probe { source, .. }
                if source.kind() == io::ErrorKind::Interrupted
                    && source.to_string() == "probe interrupted"
        ));
    }
}
