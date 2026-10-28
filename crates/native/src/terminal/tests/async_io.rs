use super::*;

async fn read_ready(terminal: &Terminal) {
    let mut output = Vec::new();
    while !output.ends_with(b"ready") {
        match next(terminal).await {
            Some(TerminalEvent::Data(data)) => output.extend(data),
            event => panic!("expected readiness handshake, got {event:?}"),
        }
    }
}

#[tokio::test]
async fn close_cancels_an_idle_reader() {
    let terminal = Terminal::spawn_command(config(), command("printf ready; IFS= read -r value"))
        .await
        .expect("spawn");
    read_ready(&terminal).await;

    tokio::time::timeout(Duration::from_secs(5), terminal.close())
        .await
        .expect("close must wake the idle reader")
        .expect("close");
    while next(&terminal).await.is_some() {}
    assert!(matches!(
        terminal.write(b"after close".to_vec()).await,
        Err(TerminalError::Closed)
    ));
}

#[tokio::test]
async fn close_immediately_after_spawn_reaps_the_child() {
    for _ in 0..16 {
        let terminal = Terminal::spawn_command(config(), command("IFS= read -r value"))
            .await
            .expect("spawn");
        tokio::time::timeout(Duration::from_secs(5), terminal.close())
            .await
            .expect("close must not race waiter startup")
            .expect("close");
        assert!(terminal.handles.has_exited());
        while next(&terminal).await.is_some() {}
    }
}

struct InputDirectory(PathBuf);

impl InputDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "deskfleet-blocked-input-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir(&path).expect("create input fixture directory");
        Self(path)
    }
}

impl Drop for InputDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn close_releases_a_backpressured_input_write() {
    let directory = InputDirectory::new();
    let mut config = config();
    config.cwd = directory.0.clone();
    // The shell waits to open the FIFO, so no process consumes PTY input.
    // Raw mode prevents the terminal line discipline from discarding full lines.
    let terminal = Terminal::spawn_command(
        config,
        command("mkfifo input; stty raw -echo; printf ready; IFS= read -r value < input"),
    )
    .await
    .expect("spawn");
    read_ready(&terminal).await;
    let writing = async {
        for _ in 0..64 {
            terminal.write(vec![b'x'; MAX_INPUT_BYTES]).await?;
        }
        Ok::<_, TerminalError>(())
    };
    tokio::pin!(writing);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut writing)
            .await
            .is_err(),
        "input must remain backpressured while the child never reads it"
    );

    // Keep polling the writer while closing so it can observe cancellation and
    // release any write serialization lock before close waits for completion.
    let (closed, written) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(5), terminal.close()),
        tokio::time::timeout(Duration::from_secs(5), writing),
    );
    closed.expect("close timeout").expect("close");
    assert!(
        written
            .expect("blocked input must settle on close")
            .is_err()
    );
    while next(&terminal).await.is_some() {}
}

#[tokio::test]
async fn saturated_output_is_drained_before_exit() {
    let chunks = OUTPUT_QUEUE_CHUNKS + 16;
    let expected_bytes = OUTPUT_CHUNK_BYTES * chunks;
    let script = format!(
        "stty -opost; dd if=/dev/zero bs={OUTPUT_CHUNK_BYTES} count={chunks} 2>/dev/null | tr '\\000' x; exit 7"
    );
    let terminal = Terminal::spawn_command(config(), command(&script))
        .await
        .expect("spawn");
    tokio::time::timeout(Duration::from_secs(5), async {
        while terminal.events.lock().await.len() < OUTPUT_QUEUE_CHUNKS {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("output queue must fill without a consumer");

    let mut output = Vec::with_capacity(expected_bytes);
    loop {
        match next(&terminal).await {
            Some(TerminalEvent::Data(data)) => output.extend(data),
            Some(TerminalEvent::Exit { exit_code: 7 }) => break,
            event => panic!("unexpected output event: {event:?}"),
        }
    }
    assert_eq!(output.len(), expected_bytes);
    assert!(output.iter().all(|byte| *byte == b'x'));
    assert_eq!(next(&terminal).await, None);
    terminal.close().await.expect("close exited terminal");
}
