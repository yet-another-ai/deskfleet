//! Maintained application identities, installation locations, and launch syntax.

use std::env;
use std::path::{Path, PathBuf};

use super::{
    DirectoryArgument, DiscoveredApplication, Launcher, LocalApplication, LocalApplicationKind,
};

struct Editor {
    id: &'static str,
    name: &'static str,
    commands: &'static [&'static str],
    mac_bundle: &'static str,
    windows_executable: &'static str,
    windows_directory: &'static str,
    linux_paths: &'static [&'static str],
}

const EDITORS: &[Editor] = &[
    Editor {
        id: "vscode",
        name: "VS Code",
        commands: &["code"],
        mac_bundle: "Visual Studio Code.app",
        windows_executable: "Code.exe",
        windows_directory: "Microsoft VS Code",
        linux_paths: &["code/code", "visual-studio-code/code"],
    },
    Editor {
        id: "cursor",
        name: "Cursor",
        commands: &["cursor"],
        mac_bundle: "Cursor.app",
        windows_executable: "Cursor.exe",
        windows_directory: "cursor",
        linux_paths: &["Cursor/cursor", "cursor/cursor"],
    },
    Editor {
        id: "vscodium",
        name: "VSCodium",
        commands: &["codium"],
        mac_bundle: "VSCodium.app",
        windows_executable: "VSCodium.exe",
        windows_directory: "VSCodium",
        linux_paths: &["codium/codium", "vscodium/codium"],
    },
    Editor {
        id: "zed",
        name: "Zed",
        commands: &["zed", "zeditor"],
        mac_bundle: "Zed.app",
        windows_executable: "zed.exe",
        windows_directory: "Zed",
        linux_paths: &["zed.app/bin/zed", "zed/zed"],
    },
];

const LINUX_TERMINALS: &[(&str, DirectoryArgument)] = &[
    ("xdg-terminal-exec", DirectoryArgument::JoinedFlag("--dir=")),
    (
        "gnome-terminal",
        DirectoryArgument::Flag("--working-directory"),
    ),
    ("konsole", DirectoryArgument::Flag("--workdir")),
    (
        "xfce4-terminal",
        DirectoryArgument::JoinedFlag("--working-directory="),
    ),
    ("kitty", DirectoryArgument::Flag("--directory")),
    ("alacritty", DirectoryArgument::Flag("--working-directory")),
    ("xterm", DirectoryArgument::CurrentDirectory),
];

#[derive(Debug)]
pub(super) struct SearchContext {
    pub platform: &'static str,
    pub paths: Vec<PathBuf>,
    pub install_roots: Vec<PathBuf>,
    pub system_root: PathBuf,
}

impl SearchContext {
    pub fn current() -> Self {
        let platform = env::consts::OS;
        // Relative and empty PATH entries must not select programs from a
        // Workspace or from the desktop process's current directory.
        let mut paths: Vec<_> = env::var_os("PATH")
            .map(|value| {
                env::split_paths(&value)
                    .filter(|path| path.is_absolute())
                    .collect()
            })
            .unwrap_or_default();
        let home = env::var_os(if platform == "windows" {
            "USERPROFILE"
        } else {
            "HOME"
        })
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
        let mut install_roots = Vec::new();
        let mut system_root = PathBuf::from("/");
        match platform {
            "macos" => {
                if let Some(home) = home {
                    install_roots.push(home.join("Applications"));
                }
                install_roots.push(PathBuf::from("/Applications"));
                paths
                    .extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
            }
            "windows" => {
                if let Some(local) = env_path("LOCALAPPDATA") {
                    install_roots.push(local.join("Programs"));
                    paths.push(local.join("Microsoft/WindowsApps"));
                }
                for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
                    if let Some(root) = env_path(variable) {
                        paths.push(root.join("PowerShell/7"));
                        install_roots.push(root);
                    }
                }
                system_root = env_path("SystemRoot").unwrap_or_else(|| PathBuf::from("C:/Windows"));
                paths.push(system_root.join("System32/WindowsPowerShell/v1.0"));
            }
            "linux" => {
                if let Some(home) = home {
                    paths.push(home.join(".local/bin"));
                    install_roots.push(home.join(".local"));
                }
                paths
                    .extend(["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"].map(PathBuf::from));
                install_roots.extend(["/opt", "/usr/share"].map(PathBuf::from));
            }
            _ => {}
        }
        Self {
            platform,
            paths,
            install_roots,
            system_root,
        }
    }

    fn command(&self, names: &[&str]) -> Option<PathBuf> {
        self.paths
            .iter()
            .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
            .find(|path| executable(path))
    }

    fn installed(&self, relative: &Path) -> Option<PathBuf> {
        self.install_roots
            .iter()
            .map(|root| root.join(relative))
            .find(|path| executable(path))
    }

    fn mac_application(&self, bundle: &str) -> Option<Launcher> {
        let open = self.system_root.join("usr/bin/open");
        if !executable(&open) {
            return None;
        }
        self.install_roots
            .iter()
            .map(|root| root.join(bundle))
            .find(|path| app_bundle(path))
            .map(|bundle| mac_launcher(open, bundle))
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

fn app_bundle(path: &Path) -> bool {
    path.is_dir() && path.join("Contents/Info.plist").is_file()
}

fn mac_launcher(open: PathBuf, bundle: PathBuf) -> Launcher {
    let mut launcher = Launcher::new(open, DirectoryArgument::Positional);
    launcher.arguments = vec!["-a".into(), bundle.into_os_string()];
    launcher
}

fn editor_launcher(context: &SearchContext, editor: &Editor) -> Option<Launcher> {
    let executable = match context.platform {
        "macos" => {
            if let Some(launcher) = context.mac_application(editor.mac_bundle) {
                return Some(launcher);
            }
            context.command(editor.commands)
        }
        "windows" => context
            .command(&[editor.windows_executable])
            .or_else(|| {
                // VS Code-family PATH entries commonly point at a bin directory
                // containing a .cmd shim. Launch its installed .exe directly.
                context
                    .paths
                    .iter()
                    .filter(|path| {
                        path.file_name()
                            .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
                    })
                    .filter_map(|path| {
                        path.parent()
                            .map(|root| root.join(editor.windows_executable))
                    })
                    .find(|path| executable(path))
            })
            .or_else(|| {
                context
                    .installed(&Path::new(editor.windows_directory).join(editor.windows_executable))
            }),
        "linux" => context.command(editor.commands).or_else(|| {
            editor
                .linux_paths
                .iter()
                .find_map(|relative| context.installed(Path::new(relative)))
        }),
        _ => None,
    }?;
    Some(Launcher::new(executable, DirectoryArgument::Positional))
}

fn terminal_launcher(context: &SearchContext) -> Option<Launcher> {
    match context.platform {
        "macos" => {
            let open = context.system_root.join("usr/bin/open");
            let terminal = context
                .system_root
                .join("System/Applications/Utilities/Terminal.app");
            if executable(&open) && app_bundle(&terminal) {
                Some(mac_launcher(open, terminal))
            } else {
                context.mac_application("Utilities/Terminal.app")
            }
        }
        "windows" => {
            if let Some(terminal) = context.command(&["wt.exe"]) {
                // Windows Terminal splits even quoted arguments at semicolons.
                // Resolve the selected directory through cwd instead of argv.
                let mut launcher = Launcher::new(terminal, DirectoryArgument::CurrentDirectory);
                launcher.arguments = vec!["-d".into(), ".".into()];
                return Some(launcher);
            }
            context
                .command(&["pwsh.exe", "powershell.exe"])
                .map(|terminal| {
                    let mut launcher = Launcher::new(terminal, DirectoryArgument::CurrentDirectory);
                    launcher.arguments.push("-NoLogo".into());
                    launcher.new_console = true;
                    launcher
                })
        }
        "linux" => LINUX_TERMINALS.iter().find_map(|(name, argument)| {
            context
                .command(&[name])
                .map(|path| Launcher::new(path, *argument))
        }),
        _ => None,
    }
}

fn file_manager_launcher(context: &SearchContext) -> Option<Launcher> {
    let path = match context.platform {
        "macos" => context.system_root.join("usr/bin/open"),
        "windows" => context.system_root.join("explorer.exe"),
        "linux" => context.command(&["xdg-open"])?,
        _ => return None,
    };
    executable(&path).then(|| Launcher::new(path, DirectoryArgument::Positional))
}

pub(super) fn discover(context: &SearchContext) -> Vec<DiscoveredApplication> {
    let mut applications: Vec<_> = EDITORS
        .iter()
        .filter_map(|editor| {
            editor_launcher(context, editor).map(|launcher| DiscoveredApplication {
                application: LocalApplication {
                    id: editor.id,
                    name: editor.name,
                    kind: LocalApplicationKind::Editor,
                },
                launcher,
            })
        })
        .collect();
    for (id, name, kind, launcher) in [
        (
            "terminal",
            "Terminal",
            LocalApplicationKind::Terminal,
            terminal_launcher(context),
        ),
        (
            "file-manager",
            "File manager",
            LocalApplicationKind::FileManager,
            file_manager_launcher(context),
        ),
    ] {
        if let Some(launcher) = launcher {
            applications.push(DiscoveredApplication {
                application: LocalApplication { id, name, kind },
                launcher,
            });
        }
    }
    applications
}
