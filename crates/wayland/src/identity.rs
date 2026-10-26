use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use crate::{APP_ID, Error, Result};

const LEGACY_FALLBACK: &str = "[Desktop Entry]\nType=Application\nName=deskfleet\nExec=deskfleet-daemon\nNoDisplay=true\nTerminal=false\n";

/// Packaged apps install this desktop entry. Source and standalone daemon runs
/// still need the same stable host identity for the portal's permission store.
pub fn ensure_desktop_entry() -> Result<()> {
    let user_data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .ok_or_else(|| {
            Error::Unavailable("no user data directory for the desktop application identity".into())
        })?;
    let system_data =
        std::env::var_os("XDG_DATA_DIRS").unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    ensure_entry(
        user_data,
        std::env::split_paths(&system_data),
        &std::env::current_exe()?,
    )
}

fn ensure_entry(
    user_data: PathBuf,
    system_data: impl Iterator<Item = PathBuf>,
    executable: &Path,
) -> Result<()> {
    let filename = format!("{APP_ID}.desktop");
    let user_entry = user_data.join("applications").join(&filename);
    if system_data
        .filter(|directory| directory != &user_data)
        .any(|directory| directory.join("applications").join(&filename).is_file())
    {
        // The hidden standalone identity must not shadow a subsequently installed launcher.
        if fs::read_to_string(&user_entry).is_ok_and(|contents| is_generated(&contents)) {
            fs::remove_file(&user_entry)?;
        }
        return Ok(());
    }
    let generated = fallback(&exec_value(executable)?);
    match fs::read_to_string(&user_entry) {
        Ok(contents) if is_generated(&contents) => {
            if contents != generated {
                fs::write(&user_entry, generated)?;
            }
            return Ok(());
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    fs::create_dir_all(user_data.join("applications"))?;
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(user_entry)
    {
        Ok(mut file) => {
            file.write_all(generated.as_bytes())?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn fallback(exec: &str) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=deskfleet\nExec={exec}\nX-Deskfleet-Generated-Exec={exec}\nNoDisplay=true\nTerminal=false\n"
    )
}

fn is_generated(contents: &str) -> bool {
    contents == LEGACY_FALLBACK
        || contents
            .lines()
            .find_map(|line| line.strip_prefix("Exec="))
            .is_some_and(|exec| contents == fallback(exec))
}

fn exec_value(executable: &Path) -> Result<String> {
    let path = executable
        .to_str()
        .ok_or_else(|| Error::Unavailable("the application executable path is not UTF-8".into()))?;
    if !executable.is_absolute() || path.contains('=') {
        return Err(Error::Unavailable(
            "the application executable path cannot be represented in a desktop entry".into(),
        ));
    }
    // Exec argument quoting is decoded after the desktop keyfile's string escaping.
    // https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html
    let mut quoted = String::from("\"");
    for character in path.chars() {
        match character {
            '\\' | '"' | '`' | '$' => {
                quoted.push('\\');
                quoted.push(character);
            }
            '%' => quoted.push_str("%%"),
            character => quoted.push(character),
        }
    }
    quoted.push('"');
    let mut escaped = String::new();
    for character in quoted.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\t' => escaped.push_str("\\t"),
            '\r' => escaped.push_str("\\r"),
            character if character.is_control() => {
                return Err(Error::Unavailable(
                    "the application executable path contains an unsupported control character"
                        .into(),
                ));
            }
            character => escaped.push(character),
        }
    }
    Ok(escaped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn installed_launcher_replaces_only_the_generated_fallback() {
        let root = std::env::temp_dir().join(format!(
            "deskfleet-identity-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let user = root.join("user");
        let system = root.join("system");
        let filename = format!("applications/{APP_ID}.desktop");
        let executable = Path::new("/test/deskfleet");
        ensure_entry(user.clone(), [system.clone()].into_iter(), executable).unwrap();
        assert_eq!(
            fs::read_to_string(user.join(&filename)).unwrap(),
            fallback("\"/test/deskfleet\"")
        );
        fs::write(user.join(&filename), LEGACY_FALLBACK).unwrap();
        ensure_entry(user.clone(), [system.clone()].into_iter(), executable).unwrap();
        assert_eq!(
            fs::read_to_string(user.join(&filename)).unwrap(),
            fallback("\"/test/deskfleet\"")
        );
        ensure_entry(
            user.clone(),
            [system.clone()].into_iter(),
            Path::new("/updated/deskfleet"),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(user.join(&filename)).unwrap(),
            fallback("\"/updated/deskfleet\"")
        );
        fs::create_dir_all(system.join("applications")).unwrap();
        fs::write(system.join(&filename), "packaged launcher").unwrap();
        ensure_entry(user.clone(), [system.clone()].into_iter(), executable).unwrap();
        assert!(!user.join(&filename).exists());
        fs::write(user.join(&filename), "custom launcher").unwrap();
        ensure_entry(user.clone(), [system].into_iter(), executable).unwrap();
        assert_eq!(
            fs::read_to_string(user.join(&filename)).unwrap(),
            "custom launcher"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_exact_owned_templates_are_refreshable() {
        assert!(is_generated(LEGACY_FALLBACK));
        let owned = fallback("\"/old/deskfleet\"");
        assert!(is_generated(&owned));
        assert!(!is_generated(
            &owned.replace("Name=deskfleet", "Name=Custom deskfleet")
        ));
        assert!(!is_generated(&owned.replacen(
            "Exec=\"/old/deskfleet\"",
            "Exec=/custom/launcher",
            1
        )));
        assert!(!is_generated("[Desktop Entry]\nExec=/custom\n"));
    }

    #[test]
    fn executable_quotes_survive_keyfile_and_exec_decoding() {
        assert_eq!(
            exec_value(Path::new("/a path/deskfleet")).unwrap(),
            "\"/a path/deskfleet\""
        );
        assert_eq!(
            exec_value(Path::new("/a\\b/\"$`%\n\t")).unwrap(),
            "\"/a\\\\\\\\b/\\\\\"\\\\$\\\\`%%\\n\\t\""
        );
        assert!(exec_value(Path::new("/has=equals")).is_err());
    }
}
