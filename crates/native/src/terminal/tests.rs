use super::*;

fn config() -> TerminalConfig {
    TerminalConfig {
        cwd: std::env::current_dir().expect("test cwd"),
        cols: 80,
        rows: 24,
    }
}

fn command(script: &str) -> CommandBuilder {
    #[cfg(unix)]
    let mut command = CommandBuilder::new("/bin/sh");
    #[cfg(unix)]
    command.args(["-c", script]);
    #[cfg(windows)]
    let mut command = CommandBuilder::new("cmd.exe");
    #[cfg(windows)]
    command.args(["/D", "/Q", "/C", script]);
    command
}

async fn next(terminal: &Terminal) -> Option<TerminalEvent> {
    tokio::time::timeout(Duration::from_secs(10), terminal.next_event())
        .await
        .expect("terminal event timeout")
        .expect("terminal event")
}

#[tokio::test]
async fn output_precedes_exit_and_stream_end() {
    #[cfg(unix)]
    let script = "printf 'terminal-output'; exit 7";
    #[cfg(windows)]
    let script = "echo terminal-output & exit /b 7";
    let terminal = Terminal::spawn_command(config(), command(script))
        .await
        .expect("spawn");
    let mut output = Vec::new();
    loop {
        match next(&terminal).await {
            Some(TerminalEvent::Data(data)) => output.extend(data),
            Some(TerminalEvent::Exit { exit_code }) => {
                assert_eq!(exit_code, 7);
                break;
            }
            event => panic!("unexpected terminal event: {event:?}"),
        }
    }
    assert!(String::from_utf8_lossy(&output).contains("terminal-output"));
    // ConPTY writes ESC[6n before the child runs and waits for a cursor report.
    // Without that answer this test stays in `next` until the timeout.
    #[cfg(windows)]
    assert!(
        !output
            .windows(super::cursor_query::QUERY.len())
            .any(|sequence| sequence == super::cursor_query::QUERY),
        "startup cursor query must be consumed before it reaches the terminal: {}",
        String::from_utf8_lossy(&output)
    );
    assert_eq!(next(&terminal).await, None);
    terminal.close().await.expect("close exited terminal");
    terminal.close().await.expect("close twice");
}

#[cfg(unix)]
#[tokio::test]
async fn input_and_resize_reach_the_same_process() {
    let terminal = Terminal::spawn_command(config(), command(
        "stty -echo; printf 'ready\\n'; IFS= read -r value; stty size; printf 'value=%s\\n' \"$value\"",
    )).await.expect("spawn");
    let mut output = Vec::new();
    while !String::from_utf8_lossy(&output).contains("ready") {
        match next(&terminal).await {
            Some(TerminalEvent::Data(data)) => output.extend(data),
            event => panic!("unexpected terminal event: {event:?}"),
        }
    }
    terminal.resize(101, 37).await.expect("resize");
    terminal
        .write("hello 世界\r".as_bytes().to_vec())
        .await
        .expect("input");
    loop {
        match next(&terminal).await {
            Some(TerminalEvent::Data(data)) => output.extend(data),
            Some(TerminalEvent::Exit { exit_code: 0 }) => break,
            event => panic!("unexpected terminal event: {event:?}"),
        }
    }
    let output = String::from_utf8_lossy(&output);
    assert!(output.contains("37 101"), "{output}");
    assert!(output.contains("value=hello 世界"), "{output}");
    assert_eq!(next(&terminal).await, None);
}

#[cfg(unix)]
#[tokio::test]
async fn close_terminates_a_busy_terminal_without_an_output_consumer() {
    let terminal = Terminal::spawn_command(
        config(),
        command("trap '' HUP; while :; do printf '0123456789012345678901234567890123456789'; done"),
    )
    .await
    .expect("spawn");
    tokio::time::sleep(Duration::from_millis(200)).await;
    tokio::time::timeout(Duration::from_secs(5), terminal.close())
        .await
        .expect("close timeout")
        .expect("close");
    assert!(
        lock(&terminal.handles.child)
            .try_wait()
            .expect("wait")
            .is_some()
    );
    while next(&terminal).await.is_some() {}
    assert!(matches!(
        terminal.write(b"hello".to_vec()).await,
        Err(TerminalError::Closed)
    ));
    assert!(matches!(
        terminal.resize(80, 24).await,
        Err(TerminalError::Closed)
    ));
    terminal.close().await.expect("close twice");
}

#[tokio::test]
async fn rejects_invalid_cwd_and_dimensions_before_spawn() {
    let mut invalid = config();
    invalid.cols = 0;
    assert!(matches!(
        Terminal::spawn(invalid).await,
        Err(TerminalError::InvalidSize)
    ));
    let mut invalid = config();
    invalid.cwd = invalid.cwd.join("not-a-terminal-test-directory");
    assert!(matches!(
        Terminal::spawn(invalid).await,
        Err(TerminalError::InvalidDirectory(_))
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn close_releases_workers_with_a_running_foreground_job() {
    let mut shell = CommandBuilder::new("/bin/sh");
    shell.arg("-i");
    let terminal = Terminal::spawn_command(config(), shell)
        .await
        .expect("spawn");
    terminal
        .write(b"sleep 30\r".to_vec())
        .await
        .expect("start job");
    tokio::time::sleep(Duration::from_millis(100)).await;
    tokio::time::timeout(Duration::from_secs(5), terminal.close())
        .await
        .expect("close timeout")
        .expect("close");
    while next(&terminal).await.is_some() {}
    tokio::time::timeout(Duration::from_secs(2), async {
        while Arc::strong_count(&terminal.handles) != 1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("workers must release PTY handles");
}

#[cfg(unix)]
#[tokio::test]
async fn shell_exit_does_not_wait_for_a_background_slave_handle() {
    let terminal = Terminal::spawn_command(config(), command("sleep 2 & printf 'done'; exit 0"))
        .await
        .expect("spawn");
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            match next(&terminal).await {
                Some(TerminalEvent::Data(_)) => {}
                Some(TerminalEvent::Exit { exit_code: 0 }) => break,
                event => panic!("unexpected event: {event:?}"),
            }
        }
        assert_eq!(next(&terminal).await, None);
    })
    .await
    .expect("shell exit must not await background jobs");
}

#[cfg(unix)]
#[tokio::test]
async fn dropping_terminal_terminates_the_owned_shell() {
    let terminal = Terminal::spawn_command(config(), command("sleep 30"))
        .await
        .expect("spawn");
    let handles = Arc::downgrade(&terminal.handles);
    let process_id = lock(&terminal.handles.child).process_id().expect("pid");
    drop(terminal);
    tokio::time::timeout(Duration::from_secs(2), async {
        while handles.strong_count() != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("drop must release all workers");
    assert_eq!(
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(i32::try_from(process_id).expect("pid fits")),
            None
        ),
        Err(nix::errno::Errno::ESRCH),
    );
}
