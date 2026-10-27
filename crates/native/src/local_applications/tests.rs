use std::fs;

use super::*;

struct Fixture {
    root: PathBuf,
    context: registry::SearchContext,
}

impl Fixture {
    fn new(platform: &'static str) -> Self {
        let root =
            std::env::temp_dir().join(format!("deskfleet-applications-{}", rand::random::<u64>()));
        fs::create_dir_all(&root).unwrap();
        let context = registry::SearchContext {
            platform,
            paths: vec![root.join("bin")],
            install_roots: vec![root.join("Applications")],
            system_root: root.join("system"),
        };
        Self { root, context }
    }

    fn executable(&self, path: impl AsRef<Path>) -> PathBuf {
        let path = self.root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // A deliberately invalid program proves discovery only checks metadata.
        fs::write(&path, "not executable program contents").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    fn directory(&self, path: impl AsRef<Path>) -> PathBuf {
        let path = self.root.join(path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn bundle(&self, path: impl AsRef<Path>) -> PathBuf {
        let path = self.directory(path);
        fs::create_dir_all(path.join("Contents")).unwrap();
        fs::write(path.join("Contents/Info.plist"), "fixture").unwrap();
        path
    }

    fn ids(&self) -> Vec<&'static str> {
        registry::discover(&self.context)
            .iter()
            .map(|entry| entry.application.id)
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn discovers_only_installed_supported_applications_without_running_them() {
    let fixture = Fixture::new("linux");
    assert!(fixture.ids().is_empty());
    fixture.executable("bin/code");
    fixture.executable("bin/cursor");
    fixture.executable("bin/code-insiders");
    fixture.executable("bin/unknown-editor");
    fixture.executable("bin/xdg-open");
    fs::create_dir_all(fixture.root.join("bin/codium")).unwrap();
    assert_eq!(fixture.ids(), ["vscode", "cursor", "file-manager"]);
}

#[cfg(unix)]
#[test]
fn discovery_requires_execute_permission() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new("linux");
    let code = fixture.executable("bin/code");
    fs::set_permissions(code, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(fixture.ids().is_empty());
}

#[test]
fn resolves_windows_installations_without_running_path_cmd_scripts() {
    let mut fixture = Fixture::new("windows");
    fixture.context.paths = vec![fixture.root.join("portable VS Code/bin")];
    fixture.executable("portable VS Code/bin/code.cmd");
    assert!(fixture.ids().is_empty());
    let code = fixture.executable("portable VS Code/Code.exe");
    fixture.executable("Applications/cursor/Cursor.exe");
    fixture.executable("Applications/VSCodium/VSCodium.exe");
    fixture.executable("Applications/Zed/zed.exe");
    assert_eq!(fixture.ids(), ["vscode", "cursor", "vscodium", "zed"]);
    let directory = fixture.directory("Workspace with spaces & quotes'");
    let launcher = resolve_launcher(&fixture.context, "vscode", &directory).unwrap();
    let command = launcher.command(&directory);
    assert_eq!(command.get_program(), code);
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        [directory.as_os_str()]
    );
    assert_eq!(command.get_current_dir(), Some(directory.as_path()));
}

#[test]
fn mac_bundles_work_without_installed_command_line_tools() {
    let fixture = Fixture::new("macos");
    let open = fixture.executable("system/usr/bin/open");
    let code = fixture.bundle(Path::new("Applications").join("Visual Studio Code.app"));
    fixture.bundle("system/System/Applications/Utilities/Terminal.app");
    assert_eq!(fixture.ids(), ["vscode", "terminal", "file-manager"]);
    let directory = fixture.directory("project with spaces");
    let launcher = resolve_launcher(&fixture.context, "vscode", &directory).unwrap();
    let command = launcher.command(&directory);
    assert_eq!(command.get_program(), open);
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        [
            std::ffi::OsStr::new("-a"),
            code.as_os_str(),
            directory.as_os_str()
        ]
    );
}

#[test]
fn linux_terminal_prefers_desktop_default_and_preserves_directory_argument() {
    let fixture = Fixture::new("linux");
    fixture.executable("bin/xterm");
    let preferred = fixture.executable("bin/xdg-terminal-exec");
    let directory = fixture.directory("project with spaces;echo");
    let launcher = resolve_launcher(&fixture.context, "terminal", &directory).unwrap();
    let command = launcher.command(&directory);
    let mut expected = OsString::from("--dir=");
    expected.push(&directory);
    assert_eq!(command.get_program(), preferred);
    assert_eq!(command.get_args().collect::<Vec<_>>(), [expected]);
    assert_eq!(command.get_current_dir(), Some(directory.as_path()));
}

#[test]
fn windows_terminal_uses_cwd_to_avoid_its_semicolon_command_parser() {
    let fixture = Fixture::new("windows");
    fixture.executable("bin/wt.exe");
    let directory = fixture.directory("project;new-tab");
    let launcher = resolve_launcher(&fixture.context, "terminal", &directory).unwrap();
    let command = launcher.command(&directory);
    assert_eq!(command.get_args().collect::<Vec<_>>(), ["-d", "."]);
    assert_eq!(command.get_current_dir(), Some(directory.as_path()));
    assert!(!launcher.new_console);
}

#[test]
fn windows_powershell_fallback_creates_an_interactive_console_with_cwd() {
    let fixture = Fixture::new("windows");
    fixture.executable("bin/powershell.exe");
    let directory = fixture.directory("project & spaces");
    let launcher = resolve_launcher(&fixture.context, "terminal", &directory).unwrap();
    let command = launcher.command(&directory);
    assert_eq!(command.get_args().collect::<Vec<_>>(), ["-NoLogo"]);
    assert_eq!(command.get_current_dir(), Some(directory.as_path()));
    assert!(launcher.new_console);
}

#[test]
fn launch_rechecks_installation_and_rejects_unknown_ids_and_invalid_directories() {
    let fixture = Fixture::new("linux");
    let code = fixture.executable("bin/code");
    let directory = fixture.directory("project");
    assert!(resolve_launcher(&fixture.context, "vscode", &directory).is_ok());
    assert!(matches!(
        resolve_launcher(&fixture.context, "/bin/sh", &directory),
        Err(LocalApplicationError::ApplicationUnavailable(_))
    ));
    assert!(matches!(
        resolve_launcher(&fixture.context, "vscode", Path::new(".")),
        Err(LocalApplicationError::InvalidDirectory)
    ));
    assert!(matches!(
        resolve_launcher(&fixture.context, "vscode", &code),
        Err(LocalApplicationError::InvalidDirectory)
    ));
    assert!(matches!(
        resolve_launcher(&fixture.context, "vscode", &fixture.root.join("missing")),
        Err(LocalApplicationError::InvalidDirectory)
    ));
    fs::remove_file(code).unwrap();
    assert!(matches!(
        resolve_launcher(&fixture.context, "vscode", &directory),
        Err(LocalApplicationError::ApplicationUnavailable(_))
    ));
}

#[tokio::test]
async fn reports_spawn_failure_from_launcher_thread() {
    let fixture = Fixture::new("linux");
    let launcher = Launcher::new(
        fixture.root.join("not installed"),
        DirectoryArgument::Positional,
    );
    assert!(matches!(
        launch(launcher, fixture.root.clone()).await,
        Err(LocalApplicationError::Launch(_))
    ));
}
