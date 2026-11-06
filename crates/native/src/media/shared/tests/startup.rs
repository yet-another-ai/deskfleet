use super::*;

/// Release a blocked opener even if the regression assertion panics.
struct ReleaseOpen(Option<std::sync::mpsc::Sender<()>>);

impl Drop for ReleaseOpen {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            let _ = release.send(());
        }
    }
}

async fn poll_pending<T>(future: std::pin::Pin<&mut impl Future<Output = T>>) {
    let mut future = future;
    std::future::poll_fn(|context| {
        assert!(future.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
}

async fn advance_past_viewer_deadline() {
    // Let delivery install its timer before moving the Tokio clock. The blocking
    // source retains real std::Instant time, so its own deadline does not elapse.
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(31)).await;
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
    tokio::time::resume();
}

#[tokio::test]
async fn slow_source_open_does_not_consume_the_first_video_budget() {
    let pool = DesktopStreamPool::default();
    let capture = CaptureState::new();
    let viewer = TestViewer::new();
    let (opening, opened) = oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let release = ReleaseOpen(Some(release));
    let source_capture = Arc::clone(&capture);
    let mut pending =
        Box::pin(
            pool.start_with(viewer.clone(), config(), Codec::H264, false, move || {
                let _ = opening.send(());
                let _ = released.recv();
                source_capture.open()()
            }),
        );
    poll_pending(pending.as_mut()).await;
    tokio::time::timeout(Duration::from_secs(3), opened)
        .await
        .expect("source opener was not scheduled")
        .unwrap();

    advance_past_viewer_deadline().await;
    drop(release);
    // The old viewer timer detached during open, then returned its error only
    // after the opener was released. A pending start alone cannot prove this.
    let stream = tokio::time::timeout(Duration::from_secs(3), pending)
        .await
        .expect("startup did not finish after opening")
        .expect("slow source opening must leave the first-video budget intact");
    assert_eq!(capture.opened.load(Ordering::Relaxed), 1);
    assert!(!viewer.values().is_empty());
    assert!(viewer.errors.lock().unwrap().is_empty());
    stream.stop().await.unwrap();
}

#[tokio::test]
async fn late_join_keyframe_timeout_is_transport_failure_and_keeps_the_source_running() {
    let pool = DesktopStreamPool::default();
    let capture = CaptureState::new();
    let healthy = TestViewer::new();
    let joining = TestViewer::new();
    let active = start(&pool, &healthy, &capture).await;
    capture.automatic_keyframes.store(false, Ordering::Relaxed);
    let mut pending = Box::pin(pool.start_with(
        joining.clone(),
        config(),
        Codec::H264,
        false,
        Arc::clone(&capture).open(),
    ));
    poll_pending(pending.as_mut()).await;
    capture.emit(7, false);
    until(|| healthy.values().contains(&7)).await;
    assert!(joining.values().is_empty());

    advance_past_viewer_deadline().await;
    let failure = tokio::time::timeout(Duration::from_secs(3), pending)
        .await
        .expect("late join did not time out")
        .err()
        .expect("missing keyframe must end this subscriber's startup");
    assert!(matches!(failure, MediaError::Transport(_)), "{failure}");
    assert_eq!(failure.fallback_reason(), None);
    {
        let errors = joining.errors.lock().unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].1, None);
    }
    assert_eq!(capture.opened.load(Ordering::Relaxed), 1);
    assert_eq!(capture.stopped.load(Ordering::Relaxed), 0);
    assert!(!active.is_finished());
    assert!(healthy.errors.lock().unwrap().is_empty());
    capture.emit(8, false);
    until(|| healthy.values().contains(&8)).await;
    active.stop().await.unwrap();
}

#[tokio::test]
async fn source_encoder_stall_preserves_codec_fallback_for_startup_failure() {
    let pool = DesktopStreamPool::default();
    let capture = CaptureState::new();
    let viewer = TestViewer::new();
    capture
        .commands
        .lock()
        .unwrap()
        .push_back(Err(MediaError::EncoderStall));
    let failure = pool
        .start_with(
            viewer.clone(),
            config(),
            Codec::H264,
            false,
            Arc::clone(&capture).open(),
        )
        .await
        .err()
        .expect("source encoder stall must fail startup");
    assert_eq!(failure.fallback_reason(), Some("encoder"));
    let errors = viewer.errors.lock().unwrap();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].1, Some("encoder"));
    assert_eq!(capture.opened.load(Ordering::Relaxed), 1);
    assert_eq!(capture.stopped.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn audio_warmup_backlog_does_not_fail_first_video_startup() {
    let pool = DesktopStreamPool::default();
    let capture = CaptureState::new();
    let viewer = TestViewer::new();
    capture.automatic_keyframes.store(false, Ordering::Relaxed);
    {
        let mut commands = capture.commands.lock().unwrap();
        // Separate capture polls emit more Opus packets than the broadcast can
        // retain while the subscriber is waiting for its first video output.
        for value in 0..12 {
            commands.push_back(Ok(vec![Packet::Audio(
                Bytes::from(vec![value]),
                Duration::from_millis(20),
            )]));
        }
    }
    let mut pending = Box::pin(pool.start_with(
        viewer.clone(),
        config(),
        Codec::H264,
        true,
        Arc::clone(&capture).open(),
    ));
    poll_pending(pending.as_mut()).await;
    until(|| capture.commands.lock().unwrap().is_empty()).await;
    poll_pending(pending.as_mut()).await;
    assert!(viewer.packets.lock().unwrap().is_empty());

    capture.emit(7, true);
    let stream = tokio::time::timeout(Duration::from_secs(3), pending)
        .await
        .expect("video startup did not complete")
        .expect("discarded warmup audio must not count as subscriber lag");
    assert_eq!(viewer.values(), [7]);
    capture
        .commands
        .lock()
        .unwrap()
        .push_back(Ok(vec![Packet::Audio(
            Bytes::from_static(&[99]),
            Duration::from_millis(20),
        )]));
    until(|| {
        viewer
            .packets
            .lock()
            .unwrap()
            .iter()
            .any(|packet| matches!(packet, Packet::Audio(data, _) if data.as_ref() == [99]))
    })
    .await;
    assert!(viewer.errors.lock().unwrap().is_empty());
    assert_eq!(capture.opened.load(Ordering::Relaxed), 1);
    stream.stop().await.unwrap();
}
