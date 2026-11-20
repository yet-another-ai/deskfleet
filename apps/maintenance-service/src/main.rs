//! On-demand Windows maintenance service for signed `DeskFleetDesktop` updates.

#[cfg(windows)]
fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match deskfleet_windows_desktop::run_maintenance_cli(&args) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(not(windows))]
fn main() -> std::process::ExitCode {
    eprintln!("the maintenance service is only available on Windows");
    std::process::ExitCode::FAILURE
}
