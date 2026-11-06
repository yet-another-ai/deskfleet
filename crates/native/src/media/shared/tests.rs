use super::*;
use std::collections::VecDeque;
use std::future::Future;
use std::sync::atomic::AtomicUsize;
use std::task::Poll;
use std::time::Duration;

use bytes::Bytes;

#[derive(Default)]
struct CaptureState {
    opened: AtomicUsize,
    stopped: AtomicUsize,
    stopping: AtomicUsize,
    block_stop: AtomicBool,
    automatic_keyframes: AtomicBool,
    commands: Mutex<VecDeque<Result<Vec<Packet>, MediaError>>>,
    feedback: Mutex<Vec<(bool, Option<f64>, bool)>>,
}

impl CaptureState {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            automatic_keyframes: AtomicBool::new(true),
            ..Self::default()
        })
    }

    fn emit(&self, value: u8, keyframe: bool) {
        self.commands
            .lock()
            .unwrap()
            .push_back(Ok(vec![video(value, keyframe)]));
    }

    fn open(self: Arc<Self>) -> impl FnOnce() -> Result<Box<dyn Capture>, MediaError> + Send {
        move || {
            self.opened.fetch_add(1, Ordering::Relaxed);
            Ok(Box::new(TestCapture(self)))
        }
    }
}

struct TestCapture(Arc<CaptureState>);

impl Capture for TestCapture {
    fn poll(
        &mut self,
        keyframe: bool,
        estimate: Option<f64>,
        video_paused: bool,
    ) -> Result<super::super::CaptureBatch, MediaError> {
        std::thread::sleep(Duration::from_millis(2));
        self.0
            .feedback
            .lock()
            .unwrap()
            .push((keyframe, estimate, video_paused));
        let packets = self
            .0
            .commands
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| {
                Ok(
                    if keyframe
                        && !video_paused
                        && self.0.automatic_keyframes.load(Ordering::Relaxed)
                    {
                        vec![video(0, true)]
                    } else {
                        Vec::new()
                    },
                )
            })?;
        Ok(super::super::CaptureBatch {
            packets,
            encoder_started: true,
        })
    }

    fn stop(self: Box<Self>) -> Result<(), MediaError> {
        self.0.stopping.fetch_add(1, Ordering::Relaxed);
        while self.0.block_stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(2));
        }
        self.0.stopped.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

struct TestViewer {
    packets: Mutex<Vec<Packet>>,
    errors: Mutex<Vec<(String, Option<&'static str>)>>,
    keyframe: AtomicBool,
    congested: AtomicBool,
    bitrate: watch::Sender<f64>,
    blocked: watch::Sender<bool>,
    writes: AtomicUsize,
}

impl TestViewer {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            packets: Mutex::new(Vec::new()),
            errors: Mutex::new(Vec::new()),
            keyframe: AtomicBool::new(false),
            congested: AtomicBool::new(false),
            bitrate: watch::channel(300_000.0).0,
            blocked: watch::channel(false).0,
            writes: AtomicUsize::new(0),
        })
    }

    fn values(&self) -> Vec<u8> {
        self.packets
            .lock()
            .unwrap()
            .iter()
            .filter_map(|packet| match packet {
                Packet::Video(data, ..) => data.first().copied(),
                Packet::Audio(..) => None,
            })
            .collect()
    }

    fn timestamp(&self, value: u8) -> Option<u64> {
        self.packets
            .lock()
            .unwrap()
            .iter()
            .find_map(|packet| match packet {
                Packet::Video(data, _, timestamp, _) if data.first() == Some(&value) => {
                    Some(*timestamp)
                }
                _ => None,
            })
    }
}

#[async_trait]
impl Viewer for TestViewer {
    fn take_keyframe_request(&self) -> bool {
        self.keyframe.swap(false, Ordering::Relaxed)
    }
    fn target_bitrate(&self) -> Option<watch::Receiver<f64>> {
        Some(self.bitrate.subscribe())
    }
    fn video_send_congested(&self) -> bool {
        self.congested.load(Ordering::Relaxed)
    }
    fn report_error(&self, error: &MediaError) {
        self.errors
            .lock()
            .unwrap()
            .push((error.to_string(), error.fallback_reason()));
    }
    async fn write(&self, packet: Packet) -> Result<(), MediaError> {
        self.writes.fetch_add(1, Ordering::Relaxed);
        let mut blocked = self.blocked.subscribe();
        while *blocked.borrow_and_update() {
            blocked.changed().await.unwrap();
        }
        self.packets.lock().unwrap().push(packet);
        Ok(())
    }
}

fn video(value: u8, keyframe: bool) -> Packet {
    Packet::Video(
        Bytes::from(vec![value]),
        Duration::from_millis(33),
        u64::from(value) * 33_000_000,
        keyframe,
    )
}

fn config() -> DesktopConfig {
    DesktopConfig {
        display_id: 1,
        fps: 1.0,
        bitrate_bps: 150_000,
        max_bitrate_bps: 0,
        max_width: Some(320),
        max_height: Some(180),
    }
}

async fn start(
    pool: &DesktopStreamPool,
    viewer: &Arc<TestViewer>,
    capture: &Arc<CaptureState>,
) -> DesktopStream {
    pool.start_with(
        viewer.clone(),
        config(),
        Codec::H264,
        false,
        Arc::clone(capture).open(),
    )
    .await
    .unwrap()
}

async fn until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("media operation did not complete");
}

#[tokio::test]
async fn concurrent_viewers_share_capture_and_last_stop_releases_it() {
    let pool = DesktopStreamPool::default();
    let capture = CaptureState::new();
    let first = TestViewer::new();
    let second = TestViewer::new();
    let (a, b) = tokio::join!(
        start(&pool, &first, &capture),
        start(&pool, &second, &capture)
    );
    assert_eq!(capture.opened.load(Ordering::Relaxed), 1);
    capture.emit(1, false);
    until(|| first.values().contains(&1) && second.values().contains(&1)).await;
    assert_eq!(first.timestamp(1), Some(33_000_000));
    assert_eq!(second.timestamp(1), first.timestamp(1));

    a.stop().await.unwrap();
    assert_eq!(capture.stopped.load(Ordering::Relaxed), 0);
    capture.emit(2, false);
    until(|| second.values().contains(&2)).await;
    assert!(!first.values().contains(&2));
    b.stop().await.unwrap();
    assert_eq!(capture.stopped.load(Ordering::Relaxed), 1);

    let next = start(&pool, &first, &capture).await;
    assert_eq!(capture.opened.load(Ordering::Relaxed), 2);
    next.stop().await.unwrap();
    assert_eq!(capture.stopped.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn late_viewer_waits_for_keyframe_and_drop_only_detaches_that_viewer() {
    let pool = Arc::new(DesktopStreamPool::default());
    let capture = CaptureState::new();
    let first = TestViewer::new();
    let second = TestViewer::new();
    let a = start(&pool, &first, &capture).await;
    capture.automatic_keyframes.store(false, Ordering::Relaxed);
    capture.feedback.lock().unwrap().clear();
    let pending = tokio::spawn({
        let pool = Arc::clone(&pool);
        let capture = Arc::clone(&capture);
        let second = Arc::clone(&second);
        async move { start(&pool, &second, &capture).await }
    });
    until(|| {
        capture
            .feedback
            .lock()
            .unwrap()
            .iter()
            .any(|(keyframe, _, _)| *keyframe)
    })
    .await;
    capture.emit(3, false);
    until(|| first.values().contains(&3)).await;
    assert!(second.values().is_empty());
    assert!(!pending.is_finished());
    capture.emit(4, true);
    let b = pending.await.unwrap();
    assert_eq!(second.values(), [4]);
    assert_eq!(second.timestamp(4), Some(132_000_000));
    assert_eq!(capture.opened.load(Ordering::Relaxed), 1);

    drop(b);
    until(|| {
        pool.sources
            .lock()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .upgrade()
            .unwrap()
            .members
            .lock()
            .unwrap()
            .viewers
            .len()
            == 1
    })
    .await;
    capture.emit(5, false);
    until(|| first.values().contains(&5)).await;
    assert_eq!(capture.stopped.load(Ordering::Relaxed), 0);
    a.stop().await.unwrap();
    assert_eq!(capture.stopped.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn distinct_media_profiles_and_registration_pools_do_not_share() {
    let pool = DesktopStreamPool::default();
    let other = DesktopStreamPool::default();
    let capture = CaptureState::new();
    let viewer = TestViewer::new();
    let mut streams = vec![start(&pool, &viewer, &capture).await];
    let mut configs = Vec::new();
    let mut display = config();
    display.display_id = 2;
    configs.push(display);
    let mut fps = config();
    fps.fps = 2.0;
    configs.push(fps);
    let mut bitrate = config();
    bitrate.bitrate_bps = 200_000;
    configs.push(bitrate);
    let mut maximum = config();
    maximum.max_bitrate_bps = 200_000;
    configs.push(maximum);
    let mut bounds = config();
    bounds.max_width = Some(640);
    configs.push(bounds);
    for config in configs {
        streams.push(
            pool.start_with(
                viewer.clone(),
                config,
                Codec::H264,
                false,
                Arc::clone(&capture).open(),
            )
            .await
            .unwrap(),
        );
    }
    streams.push(
        pool.start_with(
            viewer.clone(),
            config(),
            Codec::H265,
            false,
            Arc::clone(&capture).open(),
        )
        .await
        .unwrap(),
    );
    streams.push(
        pool.start_with(
            viewer.clone(),
            config(),
            Codec::H264,
            true,
            Arc::clone(&capture).open(),
        )
        .await
        .unwrap(),
    );
    streams.push(start(&other, &viewer, &capture).await);
    assert_eq!(capture.opened.load(Ordering::Relaxed), streams.len());
    let count = streams.len();
    for stream in streams {
        stream.stop().await.unwrap();
    }
    assert_eq!(capture.stopped.load(Ordering::Relaxed), count);
}

#[tokio::test]
async fn capture_failure_reaches_every_viewer_and_next_start_retries() {
    let pool = DesktopStreamPool::default();
    let capture = CaptureState::new();
    let first = TestViewer::new();
    let second = TestViewer::new();
    let (a, b) = tokio::join!(
        start(&pool, &first, &capture),
        start(&pool, &second, &capture)
    );
    capture
        .commands
        .lock()
        .unwrap()
        .push_back(Err(MediaError::VideoEncoder(
            deskfleet_encoder::EncoderError::Unsupported("test encoder failure"),
        )));
    until(|| a.is_finished() && b.is_finished()).await;
    for viewer in [&first, &second] {
        let errors = viewer.errors.lock().unwrap();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].0.contains("test encoder failure"));
        assert_eq!(errors[0].1, Some("encoder"));
    }
    assert_eq!(
        a.stop().await.unwrap_err().fallback_reason(),
        Some("encoder")
    );
    assert_eq!(
        b.stop().await.unwrap_err().fallback_reason(),
        Some("encoder")
    );
    assert_eq!(capture.stopped.load(Ordering::Relaxed), 1);
    let next = start(&pool, &first, &capture).await;
    assert_eq!(capture.opened.load(Ordering::Relaxed), 2);
    next.stop().await.unwrap();
}

#[tokio::test]
async fn cancelling_startup_releases_capture_without_waiting_for_a_frame() {
    let pool = Arc::new(DesktopStreamPool::default());
    let capture = CaptureState::new();
    capture.automatic_keyframes.store(false, Ordering::Relaxed);
    let pending = tokio::spawn({
        let pool = Arc::clone(&pool);
        let capture = Arc::clone(&capture);
        async move { start(&pool, &TestViewer::new(), &capture).await }
    });
    until(|| capture.opened.load(Ordering::Relaxed) == 1).await;
    pending.abort();
    assert!(matches!(pending.await, Err(error) if error.is_cancelled()));
    until(|| capture.stopped.load(Ordering::Relaxed) == 1).await;
    capture.automatic_keyframes.store(true, Ordering::Relaxed);
    let next = start(&pool, &TestViewer::new(), &capture).await;
    assert_eq!(capture.opened.load(Ordering::Relaxed), 2);
    next.stop().await.unwrap();
}

#[tokio::test]
async fn feedback_consumes_all_requests_and_removes_departed_viewers_estimates() {
    let source = Arc::new(Source::new());
    let first = TestViewer::new();
    let second = TestViewer::new();
    first.bitrate.send_replace(900_000.0);
    second.bitrate.send_replace(200_000.0);
    let (a, _packets_a) = source.attach(first.clone()).unwrap();
    let (b, _packets_b) = source.attach(second.clone()).unwrap();
    first.keyframe.store(true, Ordering::Relaxed);
    second.keyframe.store(true, Ordering::Relaxed);
    assert_eq!(source.feedback(), (true, Some(200_000.0), false));
    assert_eq!(source.feedback(), (false, Some(200_000.0), false));
    second.bitrate.send_replace(f64::NAN);
    assert_eq!(source.feedback(), (false, Some(900_000.0), false));
    second.bitrate.send_replace(100_000.0);
    assert!(!b.detach());
    assert_eq!(source.feedback(), (false, Some(900_000.0), false));
    assert!(a.detach());
    assert!(source.attach(first).is_none());
}

#[tokio::test]
async fn capture_pauses_only_when_every_active_viewer_is_congested() {
    let pool = DesktopStreamPool::default();
    let capture = CaptureState::new();
    let first = TestViewer::new();
    let second = TestViewer::new();
    let (a, b) = tokio::join!(
        start(&pool, &first, &capture),
        start(&pool, &second, &capture)
    );

    first.congested.store(true, Ordering::Relaxed);
    capture.feedback.lock().unwrap().clear();
    let frames = second.values().len();
    second.keyframe.store(true, Ordering::Relaxed);
    until(|| second.values().len() > frames).await;
    assert!(
        capture
            .feedback
            .lock()
            .unwrap()
            .iter()
            .any(|(keyframe, _, paused)| *keyframe && !paused)
    );
    assert_eq!(capture.opened.load(Ordering::Relaxed), 1);

    second.congested.store(true, Ordering::Relaxed);
    until(|| {
        capture
            .feedback
            .lock()
            .unwrap()
            .iter()
            .any(|(_, _, paused)| *paused)
    })
    .await;
    let frames = second.values().len();
    capture.feedback.lock().unwrap().clear();
    second.keyframe.store(true, Ordering::Relaxed);
    until(|| {
        capture
            .feedback
            .lock()
            .unwrap()
            .iter()
            .any(|(keyframe, _, paused)| *keyframe && *paused)
    })
    .await;
    assert_eq!(second.values().len(), frames);

    second.congested.store(false, Ordering::Relaxed);
    second.keyframe.store(true, Ordering::Relaxed);
    until(|| second.values().len() > frames).await;
    // Removing the only uncongested viewer pauses the remaining source.
    b.stop().await.unwrap();
    capture.feedback.lock().unwrap().clear();
    until(|| {
        capture
            .feedback
            .lock()
            .unwrap()
            .iter()
            .any(|(_, _, paused)| *paused)
    })
    .await;
    assert_eq!(capture.stopped.load(Ordering::Relaxed), 0);
    a.stop().await.unwrap();
}

#[tokio::test]
async fn slow_viewer_does_not_block_others_and_recovers_at_a_new_keyframe() {
    let pool = DesktopStreamPool::default();
    let capture = CaptureState::new();
    let fast = TestViewer::new();
    let slow = TestViewer::new();
    let (a, b) = tokio::join!(start(&pool, &fast, &capture), start(&pool, &slow, &capture));
    let initial_keyframes = slow.values().iter().filter(|value| **value == 0).count();
    slow.blocked.send_replace(true);
    let previous_writes = slow.writes.load(Ordering::Relaxed);
    capture.emit(10, false);
    until(|| slow.writes.load(Ordering::Relaxed) > previous_writes).await;
    for value in 11..=30 {
        capture.emit(value, false);
    }
    until(|| fast.values().contains(&30)).await;
    assert!(!slow.values().contains(&30));
    assert_eq!(capture.opened.load(Ordering::Relaxed), 1);

    slow.blocked.send_replace(false);
    until(|| slow.values().iter().filter(|value| **value == 0).count() > initial_keyframes).await;
    assert!(
        !slow.values().contains(&30),
        "dependent backlog must be discarded"
    );
    capture.emit(31, false);
    until(|| slow.values().contains(&31) && fast.values().contains(&31)).await;
    b.stop().await.unwrap();
    a.stop().await.unwrap();
}

#[tokio::test]
async fn empty_packets_and_audio_do_not_resolve_video_startup() {
    let pool = Arc::new(DesktopStreamPool::default());
    let capture = CaptureState::new();
    let viewer = TestViewer::new();
    capture.automatic_keyframes.store(false, Ordering::Relaxed);
    let pending = tokio::spawn({
        let pool = Arc::clone(&pool);
        let capture = Arc::clone(&capture);
        let viewer = Arc::clone(&viewer);
        async move { start(&pool, &viewer, &capture).await }
    });
    until(|| capture.opened.load(Ordering::Relaxed) == 1).await;
    capture.commands.lock().unwrap().push_back(Ok(vec![
        Packet::Video(Bytes::new(), Duration::ZERO, 0, true),
        Packet::Audio(Bytes::from_static(&[1]), Duration::from_millis(20)),
        video(2, false),
    ]));
    until(|| capture.commands.lock().unwrap().is_empty()).await;
    assert!(!pending.is_finished());
    assert!(viewer.values().is_empty());
    capture.emit(3, true);
    let stream = pending.await.unwrap();
    assert_eq!(viewer.values(), [3]);
    stream.stop().await.unwrap();
}

#[tokio::test]
async fn replacing_final_subscriber_waits_for_hardware_shutdown() {
    struct ReleaseStop(Arc<CaptureState>);
    impl Drop for ReleaseStop {
        fn drop(&mut self) {
            self.0.block_stop.store(false, Ordering::Relaxed);
        }
    }
    let pool = DesktopStreamPool::default();
    let capture = CaptureState::new();
    let viewer = TestViewer::new();
    let first = start(&pool, &viewer, &capture).await;
    capture.block_stop.store(true, Ordering::Relaxed);
    let release = ReleaseStop(Arc::clone(&capture));
    let stopping = tokio::spawn(first.stop());
    until(|| capture.stopping.load(Ordering::Relaxed) == 1).await;
    let mut next = Box::pin(start(&pool, &viewer, &capture));
    std::future::poll_fn(|context| {
        assert!(next.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
    assert_eq!(capture.opened.load(Ordering::Relaxed), 1);
    drop(release);
    stopping.await.unwrap().unwrap();
    let next = next.await;
    assert_eq!(capture.opened.load(Ordering::Relaxed), 2);
    next.stop().await.unwrap();
    assert_eq!(capture.stopped.load(Ordering::Relaxed), 2);
}

#[tokio::test]
async fn audio_overrun_stops_only_the_lagging_viewer() {
    let pool = DesktopStreamPool::default();
    let capture = CaptureState::new();
    let fast = TestViewer::new();
    let slow = TestViewer::new();
    let (a, b) = tokio::join!(
        pool.start_with(
            fast.clone(),
            config(),
            Codec::H264,
            true,
            Arc::clone(&capture).open()
        ),
        pool.start_with(
            slow.clone(),
            config(),
            Codec::H264,
            true,
            Arc::clone(&capture).open()
        ),
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    slow.blocked.send_replace(true);
    let previous_writes = slow.writes.load(Ordering::Relaxed);
    capture.emit(10, false);
    until(|| slow.writes.load(Ordering::Relaxed) > previous_writes).await;
    for value in 11..=30 {
        capture.emit(value, false);
    }
    until(|| fast.values().contains(&30)).await;
    slow.blocked.send_replace(false);
    until(|| b.is_finished()).await;
    assert!(matches!(b.stop().await, Err(MediaError::Transport(_))));
    assert!(!a.is_finished());
    assert_eq!(capture.opened.load(Ordering::Relaxed), 1);
    assert_eq!(capture.stopped.load(Ordering::Relaxed), 0);
    assert!(fast.errors.lock().unwrap().is_empty());
    assert_eq!(slow.errors.lock().unwrap().len(), 1);
    capture.emit(31, false);
    until(|| fast.values().contains(&31)).await;
    a.stop().await.unwrap();
}

mod startup;
