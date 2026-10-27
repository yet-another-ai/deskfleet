//! Discover and launch a maintained set of applications on the client machine.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

mod registry;

#[cfg(test)]
mod tests;

/// Purpose of an application offered by the local desktop client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalApplicationKind {
    Editor,
    Terminal,
    FileManager,
}

/// A discovered application. Executable paths stay inside the native boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalApplication {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: LocalApplicationKind,
}

/// Failures to discover or start a local application.
#[derive(Debug, thiserror::Error)]
pub enum LocalApplicationError {
    #[error("local application worker failed: {0}")]
    Worker(#[from] tokio::task::JoinError),
    #[error("application is not installed or supported: {0}")]
    ApplicationUnavailable(String),
    #[error("application directory must be an absolute existing directory")]
    InvalidDirectory,
    #[error("failed to start local application: {0}")]
    Launch(#[source] std::io::Error),
    #[error("local application launcher stopped before reporting its result")]
    LauncherStopped,
}

#[derive(Debug, Clone, Copy)]
enum DirectoryArgument {
    Positional,
    Flag(&'static str),
    JoinedFlag(&'static str),
    CurrentDirectory,
}

#[derive(Debug)]
struct Launcher {
    executable: PathBuf,
    arguments: Vec<OsString>,
    directory_argument: DirectoryArgument,
    new_console: bool,
}

impl Launcher {
    fn new(executable: PathBuf, directory_argument: DirectoryArgument) -> Self {
        Self {
            executable,
            arguments: Vec::new(),
            directory_argument,
            new_console: false,
        }
    }

    fn command(&self, directory: &Path) -> Command {
        let mut command = Command::new(&self.executable);
        command.args(&self.arguments).current_dir(directory);
        match self.directory_argument {
            DirectoryArgument::Positional => {
                command.arg(directory);
            }
            DirectoryArgument::Flag(flag) => {
                command.arg(flag).arg(directory);
            }
            DirectoryArgument::JoinedFlag(flag) => {
                let mut argument = OsString::from(flag);
                argument.push(directory);
                command.arg(argument);
            }
            DirectoryArgument::CurrentDirectory => {}
        }
        // A directly launched PowerShell needs its own interactive console.
        // GUI applications and terminal emulators own their own input/output.
        if !self.new_console {
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
        }
        #[cfg(windows)]
        if self.new_console {
            use std::os::windows::process::CommandExt;
            use windows::Win32::System::Threading::CREATE_NEW_CONSOLE;
            command.creation_flags(CREATE_NEW_CONSOLE.0);
        }
        command
    }
}

#[derive(Debug)]
struct DiscoveredApplication {
    application: LocalApplication,
    launcher: Launcher,
}

/// Discover installed, supported applications without executing them.
///
/// # Errors
/// Returns an error if the discovery worker fails.
pub async fn scan_local_applications() -> Result<Vec<LocalApplication>, LocalApplicationError> {
    Ok(tokio::task::spawn_blocking(|| {
        registry::discover(&registry::SearchContext::current())
            .into_iter()
            .map(|entry| entry.application)
            .collect()
    })
    .await?)
}

fn resolve_launcher(
    context: &registry::SearchContext,
    application_id: &str,
    directory: &Path,
) -> Result<Launcher, LocalApplicationError> {
    if !directory.is_absolute() || !directory.is_dir() {
        return Err(LocalApplicationError::InvalidDirectory);
    }
    registry::discover(context)
        .into_iter()
        .find(|entry| entry.application.id == application_id)
        .map(|entry| entry.launcher)
        .ok_or_else(|| LocalApplicationError::ApplicationUnavailable(application_id.to_owned()))
}

/// Start a known installed application with one absolute existing directory.
/// The caller owns authorization of that local directory. Discovery is repeated
/// for every launch; callers cannot supply an executable or custom arguments.
/// Completion means the process started, not that its application window opened.
///
/// # Errors
/// Returns an error for an invalid directory, unavailable application, or a
/// failure to start the worker or application process.
pub async fn open_local_application(
    application_id: String,
    directory: PathBuf,
) -> Result<(), LocalApplicationError> {
    let (launcher, directory) = tokio::task::spawn_blocking(move || {
        resolve_launcher(
            &registry::SearchContext::current(),
            &application_id,
            &directory,
        )
        .map(|launcher| (launcher, directory))
    })
    .await??;
    launch(launcher, directory).await
}

async fn launch(launcher: Launcher, directory: PathBuf) -> Result<(), LocalApplicationError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // Start and reap on the same dedicated thread. A long-lived editor must not
    // occupy a Tokio blocking worker or delay the Node runtime's shutdown.
    std::thread::Builder::new()
        .name("local-application".to_owned())
        .spawn(move || match launcher.command(&directory).spawn() {
            Ok(mut child) => {
                let _ = sender.send(Ok(()));
                match child.wait() {
                    Ok(status) if !status.success() => {
                        tracing::warn!(?status, "local application exited unsuccessfully");
                    }
                    Err(error) => {
                        tracing::warn!(%error, "failed to wait for local application");
                    }
                    Ok(_) => {}
                }
            }
            Err(error) => {
                let _ = sender.send(Err(LocalApplicationError::Launch(error)));
            }
        })
        .map_err(LocalApplicationError::Launch)?;
    receiver
        .await
        .map_err(|_| LocalApplicationError::LauncherStopped)?
}
