//! Open a fixed macOS privacy pane from a permission worker.

use std::io;
use std::process::Command;

pub(crate) fn open(pane: &str) -> io::Result<()> {
    open_url(&format!(
        "x-apple.systempreferences:com.apple.preference.security?{pane}"
    ))
}

pub(crate) fn open_url(url: &str) -> io::Result<()> {
    let output = Command::new("/usr/bin/open").arg(url).output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "System Settings failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(())
}
