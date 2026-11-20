//! File replacement for the optional service, independent of SCM and elevation.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The caller serializes setup and validates/protects these sibling paths before
/// replacing an executable. Staging and backup finish while the old service runs.
pub(crate) struct PreparedInstall {
    executable: PathBuf,
    staging: PathBuf,
    previous: Option<PathBuf>,
    replaced: bool,
}

impl PreparedInstall {
    pub(crate) fn stage(source: &Path, executable: &Path) -> io::Result<Self> {
        Self::stage_named(
            source,
            executable,
            "desktop-service.installing.exe",
            "desktop-service.previous.exe",
        )
    }

    pub(crate) fn stage_named(
        source: &Path,
        executable: &Path,
        staging_name: &str,
        previous_name: &str,
    ) -> io::Result<Self> {
        let directory = executable
            .parent()
            .ok_or_else(|| io::Error::other("invalid service executable directory"))?;
        let prepared = Self {
            executable: executable.to_owned(),
            staging: directory.join(staging_name),
            previous: executable
                .try_exists()?
                .then(|| directory.join(previous_name)),
            replaced: false,
        };
        fs::copy(source, &prepared.staging)?;
        if let Some(previous) = &prepared.previous {
            fs::copy(executable, previous)?;
        }
        Ok(prepared)
    }

    /// Adopts a caller-verified staged file already placed inside the protected
    /// directory and prepares the recovery copy of the currently installed binary.
    pub(crate) fn from_staged(
        staging: PathBuf,
        executable: &Path,
        previous_name: &str,
    ) -> io::Result<Self> {
        let directory = executable
            .parent()
            .ok_or_else(|| io::Error::other("invalid service executable directory"))?;
        let previous = executable
            .try_exists()?
            .then(|| directory.join(previous_name));
        let prepared = Self {
            executable: executable.to_owned(),
            staging,
            previous,
            replaced: false,
        };
        if let Some(previous) = &prepared.previous {
            fs::copy(executable, previous)?;
        }
        Ok(prepared)
    }

    pub(crate) fn staging(&self) -> &Path {
        &self.staging
    }

    pub(crate) fn previous(&self) -> Option<&Path> {
        self.previous.as_deref()
    }

    /// Windows std::fs::rename uses MoveFileExW with replacement enabled. The
    /// caller has waited for the previous service and workers to exit.
    pub(crate) fn replace(&mut self) -> io::Result<()> {
        fs::rename(&self.staging, &self.executable)?;
        self.replaced = true;
        Ok(())
    }

    /// Keep the backup if restoring fails so setup never destroys its recovery copy.
    pub(crate) fn rollback(&mut self) -> io::Result<()> {
        if !self.replaced {
            return Ok(());
        }
        if let Some(previous) = &self.previous {
            fs::rename(previous, &self.executable)?;
        } else {
            fs::remove_file(&self.executable)?;
        }
        self.replaced = false;
        Ok(())
    }

    pub(crate) fn commit(mut self) -> io::Result<()> {
        if let Some(previous) = &self.previous {
            remove_if_present(previous)?;
        }
        self.replaced = false;
        Ok(())
    }
}

impl Drop for PreparedInstall {
    fn drop(&mut self) {
        if let Err(error) = remove_if_present(&self.staging) {
            tracing::warn!(%error, "remove staged desktop service executable failed");
        }
        if !self.replaced
            && let Some(previous) = &self.previous
            && let Err(error) = remove_if_present(previous)
        {
            tracing::warn!(%error, "remove desktop service recovery executable failed");
        }
    }
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "deskfleet-install-files-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn staging_failure_leaves_previous_executable_available() {
        let directory = Directory::new();
        let executable = directory.file("service.exe");
        fs::write(&executable, b"previous").unwrap();
        assert!(PreparedInstall::stage(&directory.file("missing.exe"), &executable).is_err());
        assert_eq!(fs::read(&executable).unwrap(), b"previous");
    }

    #[test]
    fn failed_start_restores_previous_executable_without_a_missing_destination() {
        let directory = Directory::new();
        let executable = directory.file("service.exe");
        let source = directory.file("new.exe");
        fs::write(&executable, b"previous").unwrap();
        fs::write(&source, b"replacement").unwrap();
        let mut prepared = PreparedInstall::stage(&source, &executable).unwrap();
        assert_eq!(fs::read(&executable).unwrap(), b"previous");
        assert_eq!(fs::read(prepared.staging()).unwrap(), b"replacement");
        assert_eq!(fs::read(prepared.previous().unwrap()).unwrap(), b"previous");
        prepared.replace().unwrap();
        assert_eq!(fs::read(&executable).unwrap(), b"replacement");
        prepared.rollback().unwrap();
        drop(prepared);
        assert_eq!(fs::read(&executable).unwrap(), b"previous");
        assert!(!directory.file("desktop-service.previous.exe").exists());
    }

    #[test]
    fn successful_upgrade_removes_recovery_files() {
        let directory = Directory::new();
        let executable = directory.file("service.exe");
        let source = directory.file("new.exe");
        fs::write(&executable, b"previous").unwrap();
        fs::write(&source, b"replacement").unwrap();
        let mut prepared = PreparedInstall::stage(&source, &executable).unwrap();
        prepared.replace().unwrap();
        prepared.commit().unwrap();
        assert_eq!(fs::read(&executable).unwrap(), b"replacement");
        assert!(!directory.file("desktop-service.previous.exe").exists());
        assert!(!directory.file("desktop-service.installing.exe").exists());
    }

    #[test]
    fn failed_first_install_removes_new_executable() {
        let directory = Directory::new();
        let executable = directory.file("service.exe");
        let source = directory.file("new.exe");
        fs::write(&source, b"replacement").unwrap();
        let mut prepared = PreparedInstall::stage(&source, &executable).unwrap();
        prepared.replace().unwrap();
        prepared.rollback().unwrap();
        assert!(!executable.exists());
    }

    #[test]
    fn from_staged_backs_up_replaces_and_rolls_back_verified_staging_file() {
        let directory = Directory::new();
        let executable = directory.file("service.exe");
        let staging = directory.file("desktop-service.installing.exe");
        fs::write(&executable, b"old-binary").unwrap();
        fs::write(&staging, b"verified-new").unwrap();
        let mut prepared =
            PreparedInstall::from_staged(staging, &executable, "desktop-service.previous.exe")
                .unwrap();
        prepared.replace().unwrap();
        assert_eq!(fs::read(&executable).unwrap(), b"verified-new");
        prepared.rollback().unwrap();
        drop(prepared);
        assert_eq!(fs::read(&executable).unwrap(), b"old-binary");
        assert!(!directory.file("desktop-service.previous.exe").exists());
        assert!(!directory.file("desktop-service.installing.exe").exists());
    }
}
