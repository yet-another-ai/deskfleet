use super::*;
use nix::libc;
use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd};

#[tokio::test]
async fn inherited_descriptor_closes_on_exec_without_changing_parent() {
    let path = std::env::temp_dir().join(format!(
        "deskfleet-pty-fd-{}-{}",
        std::process::id(),
        rand::random::<u64>(),
    ));
    let file = File::create_new(&path).expect("create unique inherited file");
    let inherited = inheritable_duplicate(&file);
    let flags_before = descriptor_flags(&inherited);
    assert_eq!(
        flags_before & libc::FD_CLOEXEC,
        0,
        "sentinel must be inheritable"
    );

    // Compare file identities so unrelated descriptors from parallel tests do
    // not affect the result. Check the shell's FD table, not a helper process's.
    let script = r#"if [ "/proc/$$/fd/$1" -ef "$2" ]; then
        printf 'descriptor-inherited'; exit 13
    fi
    printf 'descriptor-closed'"#;
    let args = vec![
        "-c".into(),
        script.into(),
        "deskfleet-fd-probe".into(),
        inherited.as_raw_fd().to_string(),
        path.to_str().expect("UTF-8 temp path").into(),
    ];
    // Prove that this shell retains our sentinel when PTY cleanup is absent.
    let control = std::process::Command::new("/bin/sh")
        .args(&args)
        .output()
        .expect("spawn inheritance control");
    assert_eq!(control.status.code(), Some(13), "{control:?}");

    let mut config = config();
    config.command = Some("/bin/sh".into());
    config.args = args;
    let terminal = Terminal::spawn(config).await.expect("spawn PTY fd probe");
    let mut output = Vec::new();
    loop {
        match next(&terminal).await {
            Some(TerminalEvent::Data(data)) => output.extend(data),
            Some(TerminalEvent::Exit { exit_code }) => {
                assert_eq!(exit_code, 0, "{}", String::from_utf8_lossy(&output));
                break;
            }
            event => panic!("unexpected fd probe event: {event:?}"),
        }
    }
    assert_eq!(String::from_utf8_lossy(&output), "descriptor-closed");
    assert_eq!(next(&terminal).await, None);
    terminal.close().await.expect("close fd probe terminal");
    assert_eq!(descriptor_flags(&inherited), flags_before);
    inherited
        .metadata()
        .expect("parent descriptor remains valid");
    std::fs::remove_file(path).expect("remove inherited file");
}

#[allow(unsafe_code)]
fn inheritable_duplicate(file: &File) -> File {
    // A high descriptor avoids reuse by the shell's own startup descriptors.
    // SAFETY: file owns a valid descriptor; F_DUPFD returns a new owned descriptor.
    let raw_fd = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, 200) };
    assert!(
        raw_fd >= 200,
        "duplicate fd: {}",
        std::io::Error::last_os_error()
    );
    // SAFETY: F_DUPFD succeeded and this is the new descriptor's only owner.
    unsafe { File::from_raw_fd(raw_fd) }
}

#[allow(unsafe_code)]
fn descriptor_flags(file: &File) -> libc::c_int {
    // SAFETY: file owns a valid descriptor; F_GETFD does not change ownership.
    let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
    assert_ne!(
        flags,
        -1,
        "read fd flags: {}",
        std::io::Error::last_os_error()
    );
    flags
}
