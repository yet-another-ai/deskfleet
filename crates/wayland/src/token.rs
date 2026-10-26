use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

use crate::Result;

const FILE: &str = "wayland-restore-token";

// Tokens are opaque portal secrets, including non-UUID tokens from newer portals.
pub fn read(directory: &Path) -> Result<Option<String>> {
    match fs::read_to_string(directory.join(FILE)) {
        Ok(token) if !token.is_empty() => Ok(Some(token)),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn write(directory: &Path, token: Option<&str>) -> Result<()> {
    let path = directory.join(FILE);
    let Some(token) = token.filter(|value| !value.is_empty()) else {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        };
    };
    fs::create_dir_all(directory)?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let temporary = directory.join(format!(
        ".{FILE}.{}.{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(token.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        std::fs::File::open(directory)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::PermissionsExt,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn opaque_tokens_rotate_atomically_and_can_be_revoked() {
        let directory = std::env::temp_dir().join(format!(
            "deskfleet-token-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        assert_eq!(read(&directory).unwrap(), None);
        write(&directory, Some("opaque:token/with padding==")).unwrap();
        assert_eq!(
            read(&directory).unwrap().as_deref(),
            Some("opaque:token/with padding==")
        );
        assert_eq!(
            fs::metadata(directory.join(FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        write(&directory, Some("replacement")).unwrap();
        assert_eq!(read(&directory).unwrap().as_deref(), Some("replacement"));
        write(&directory, None).unwrap();
        assert_eq!(read(&directory).unwrap(), None);
        fs::remove_dir(directory).unwrap();
    }
}
