//! Optional desktop-only Windows service; the user daemon retains all team authority.

#[cfg(windows)]
fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match deskfleet_windows_desktop::run_cli(&args, deskfleet_native::windows_desktop::serve) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(not(windows))]
fn main() -> std::process::ExitCode {
    eprintln!("the desktop service is only available on Windows");
    std::process::ExitCode::FAILURE
}
