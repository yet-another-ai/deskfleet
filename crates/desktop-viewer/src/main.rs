#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    if let Err(error) = deskfleet_desktop_viewer::run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
