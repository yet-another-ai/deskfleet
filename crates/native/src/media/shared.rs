//! Registration-owned capture sources and independently cancellable viewers.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;

use async_trait::async_trait;
use deskfleet_encoder::Codec;
use tokio::sync::{broadcast, oneshot, watch};
use tokio::task::JoinHandle;

use super::{CaptureSource, DesktopConfig, FIRST_FRAME_TIMEOUT, MediaError, Packet};
use crate::rtc::{Peer, VideoCodec};

#[derive(Clone, PartialEq, Eq, Hash)]
struct Profile {
    display: u32,
    codec: &'static str,
    audio: bool,
    fps: u64,
    bitrate: u32,
    max_bitrate: u32,
    bounds: (Option<u32>, Option<u32>),
}

impl Profile {
    fn new(config: &DesktopConfig, codec: Codec, audio: bool) -> Self {
        Self {
            display: config.display_id,
            codec: codec.as_str(),
            audio,
            fps: config.fps.to_bits(),
            bitrate: config.bitrate_bps,
            max_bitrate: config.max_bitrate_bps,
            bounds: (config.max_width, config.max_height),
        }
    }
}

/// Own one pool per authorized Machine registration, never across Teams/backends.
/// Creating a pool does not acquire desktop access or initialize media hardware.
#[derive(Default)]
pub struct DesktopStreamPool {
    sources: Mutex<HashMap<Profile, Weak<Source>>>,
}

impl DesktopStreamPool {
    /// Attach an authorized viewer, sharing capture only for an identical media profile.
    pub async fn start(
        &self,
        peer: Arc<Peer>,
        config: DesktopConfig,
    ) -> Result<DesktopStream, MediaError> {
        let codec = match peer.video_codec() {
            Some(VideoCodec::H264) => Codec::H264,
            Some(VideoCodec::H265) => Codec::H265,
            Some(VideoCodec::Av1) => Codec::AV1,
            None => return Err(MediaError::InvalidConfig("peer has no video track")),
        };
        let audio = peer.has_audio();
        let source_config = config.clone();
        self.start_with(peer, config, codec, audio, move || {
            CaptureSource::open(source_config, codec, audio).map(|source| Box::new(source) as _)
        })
        .await
    }

    async fn start_with(
        &self,
        viewer: Arc<dyn Viewer>,
        config: DesktopConfig,
        codec: Codec,
        audio: bool,
        open: impl FnOnce() -> Result<Box<dyn Capture>, MediaError> + Send + 'static,
    ) -> Result<DesktopStream, MediaError> {
        config.validate()?;
        let profile = Profile::new(&config, codec, audio);
        let mut open = Some(open);
        let (membership, packets) = loop {
            let source = {
                let mut sources = self.sources.lock().unwrap_or_else(|e| e.into_inner());
                sources.retain(|_, source| source.strong_count() > 0);
                if let Some(source) = sources.get(&profile).and_then(Weak::upgrade) {
                    source
                } else {
                    let source = Arc::new(Source::new());
                    sources.insert(profile.clone(), Arc::downgrade(&source));
                    source
                }
            };
            if let Some(subscription) = source.attach(Arc::clone(&viewer)) {
                // Only the first subscriber starts the worker. Attach and start are
                // synchronous, so cancellation cannot leave an unstarted source behind.
                source.start(&mut open);
                break subscription;
            }
            // Last-detach has committed to shutdown. Wait for hardware release before
            // replacing that source, avoiding a temporary extra encoder on reconnect.
            let _ = source.finished().await;
            let mut sources = self.sources.lock().unwrap_or_else(|e| e.into_inner());
            if sources
                .get(&profile)
                .is_some_and(|entry| entry.ptr_eq(&Arc::downgrade(&source)))
            {
                sources.remove(&profile);
            }
        };
        let (shutdown, shutdown_rx) = watch::channel(());
        let (ready, started) = oneshot::channel();
        let source = Arc::clone(&membership.source);
        let delivery = tokio::spawn(async move {
            let result = deliver(&source, &viewer, packets, shutdown_rx, ready, audio).await;
            let last = membership.detach();
            let result = if last {
                source.finished().await.and(result)
            } else {
                result
            };
            if let Err(error) = &result {
                viewer.report_error(error);
            }
            result
        });
        let stream = DesktopStream {
            shutdown: Some(shutdown),
            delivery: Some(delivery),
        };
        match started.await {
            Ok(()) => Ok(stream),
            Err(_) => {
                stream.stop().await?;
                Err(MediaError::Startup)
            }
        }
    }
}

/// One viewer's subscription. Stopping it leaves the shared source alive while
/// other viewers remain; the final stop waits for capture/encoder cleanup.
pub struct DesktopStream {
    shutdown: Option<watch::Sender<()>>,
    delivery: Option<JoinHandle<Result<(), MediaError>>>,
}

impl DesktopStream {
    /// Start a standalone source when no registration-owned pool is supplied.
    pub async fn start(peer: Arc<Peer>, config: DesktopConfig) -> Result<Self, MediaError> {
        DesktopStreamPool::default().start(peer, config).await
    }

    pub fn is_finished(&self) -> bool {
        self.delivery.as_ref().is_none_or(JoinHandle::is_finished)
    }

    pub async fn stop(mut self) -> Result<(), MediaError> {
        self.shutdown.take();
        match self.delivery.take() {
            Some(delivery) => delivery.await?,
            None => Ok(()),
        }
    }
}

impl Drop for DesktopStream {
    fn drop(&mut self) {
        self.shutdown.take();
        if let Some(delivery) = &self.delivery {
            delivery.abort();
        }
    }
}

// These two boundaries let ownership and fan-out be tested without GPU access
// or a negotiated network connection. Production capture stays on one OS thread.
trait Capture {
    fn poll(
        &mut self,
        keyframe: bool,
        estimate: Option<f64>,
        video_paused: bool,
    ) -> Result<super::CaptureBatch, MediaError>;
    fn stop(self: Box<Self>) -> Result<(), MediaError>;
}

impl Capture for CaptureSource {
    fn poll(
        &mut self,
        keyframe: bool,
        estimate: Option<f64>,
        video_paused: bool,
    ) -> Result<super::CaptureBatch, MediaError> {
        CaptureSource::poll(self, keyframe, estimate, video_paused)
    }

    fn stop(self: Box<Self>) -> Result<(), MediaError> {
        CaptureSource::stop(*self)
    }
}

#[async_trait]
trait Viewer: Send + Sync {
    fn take_keyframe_request(&self) -> bool;
    fn target_bitrate(&self) -> Option<watch::Receiver<f64>>;
    fn video_send_congested(&self) -> bool;
    fn report_error(&self, error: &MediaError);
    async fn write(&self, packet: Packet) -> Result<(), MediaError>;
}

#[async_trait]
impl Viewer for Peer {
    fn take_keyframe_request(&self) -> bool {
        self.take_keyframe_request()
    }
    fn target_bitrate(&self) -> Option<watch::Receiver<f64>> {
        self.subscribe_target_bitrate()
    }
    fn video_send_congested(&self) -> bool {
        self.video_send_congested()
    }
    fn report_error(&self, error: &MediaError) {
        self.report_media_error(error.to_string(), error.fallback_reason());
    }
    async fn write(&self, packet: Packet) -> Result<(), MediaError> {
        match packet {
            Packet::Video(data, duration, timestamp_ns, _) => {
                self.write_video_at(data, duration, timestamp_ns).await
            }
            Packet::Audio(data, duration) => self.write_audio(data, duration).await,
        }
        .map_err(|error| MediaError::Transport(error.to_string()))
    }
}

struct Member {
    viewer: Arc<dyn Viewer>,
    bitrate: Option<watch::Receiver<f64>>,
}

#[derive(Default)]
struct Members {
    next: u64,
    viewers: HashMap<u64, Member>,
}

type Completion = Option<Result<(), Arc<MediaError>>>;

struct Source {
    members: Mutex<Members>,
    started: AtomicBool,
    stopping: AtomicBool,
    keyframe: AtomicBool,
    encoder_started: AtomicBool,
    packets: broadcast::Sender<Packet>,
    completion: watch::Sender<Completion>,
}

impl Source {
    fn new() -> Self {
        Self {
            members: Mutex::new(Members::default()),
            started: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            keyframe: AtomicBool::new(true),
            encoder_started: AtomicBool::new(false),
            packets: broadcast::channel(8).0,
            completion: watch::channel(None).0,
        }
    }

    fn attach(
        self: &Arc<Self>,
        viewer: Arc<dyn Viewer>,
    ) -> Option<(Membership, broadcast::Receiver<Packet>)> {
        let mut members = self.members.lock().unwrap_or_else(|e| e.into_inner());
        if self.stopping.load(Ordering::Relaxed) {
            return None;
        }
        let id = members.next;
        members.next += 1;
        let packets = self.packets.subscribe();
        members.viewers.insert(
            id,
            Member {
                bitrate: viewer.target_bitrate(),
                viewer,
            },
        );
        self.keyframe.store(true, Ordering::Relaxed);
        Some((
            Membership {
                source: Arc::clone(self),
                id: Some(id),
            },
            packets,
        ))
    }

    fn start(
        self: &Arc<Self>,
        open: &mut Option<impl FnOnce() -> Result<Box<dyn Capture>, MediaError> + Send + 'static>,
    ) {
        if self.started.swap(true, Ordering::Relaxed) {
            return;
        }
        let open = open.take().expect("new capture source requires a factory");
        let source = Arc::clone(self);
        let capture = tokio::task::spawn_blocking(move || source.capture(open));
        let source = Arc::clone(self);
        tokio::spawn(async move {
            let result = capture
                .await
                .map_err(MediaError::from)
                .and_then(|result| result);
            // Fence attachment before publishing completion, including worker panics.
            let _members = source.members.lock().unwrap_or_else(|e| e.into_inner());
            source.stopping.store(true, Ordering::Relaxed);
            source
                .completion
                .send_replace(Some(result.map_err(Arc::new)));
        });
    }

    fn feedback(&self) -> (bool, Option<f64>, bool) {
        let mut keyframe = self.keyframe.swap(false, Ordering::Relaxed);
        let mut estimate: Option<f64> = None;
        let mut video_paused = true;
        let mut members = self.members.lock().unwrap_or_else(|e| e.into_inner());
        for member in members.viewers.values_mut() {
            keyframe |= member.viewer.take_keyframe_request();
            // One healthy viewer still needs current frames. A slow viewer has
            // its own bounded delivery and can recover without pausing others.
            video_paused &= member.viewer.video_send_congested();
            if let Some(bitrate) = &mut member.bitrate {
                let target = *bitrate.borrow_and_update();
                if target.is_finite() && target > 0.0 {
                    estimate = Some(estimate.map_or(target, |current| current.min(target)));
                }
            }
        }
        (keyframe, estimate, video_paused)
    }

    fn capture(
        &self,
        open: impl FnOnce() -> Result<Box<dyn Capture>, MediaError>,
    ) -> Result<(), MediaError> {
        let mut capture = open()?;
        let deadline = Instant::now() + FIRST_FRAME_TIMEOUT;
        let mut has_video = false;
        let result = (|| {
            while !self.stopping.load(Ordering::Relaxed) {
                if !has_video && Instant::now() >= deadline {
                    return Err(self.startup_error());
                }
                let (keyframe, bitrate, video_paused) = self.feedback();
                let batch = capture.poll(keyframe, bitrate, video_paused)?;
                self.encoder_started
                    .store(batch.encoder_started, Ordering::Relaxed);
                for packet in batch.packets {
                    let empty = match &packet {
                        Packet::Video(data, ..) | Packet::Audio(data, _) => data.is_empty(),
                    };
                    if empty {
                        continue;
                    }
                    has_video |= matches!(packet, Packet::Video(..));
                    let _ = self.packets.send(packet);
                }
            }
            Ok(())
        })();
        result.and(capture.stop())
    }

    fn startup_error(&self) -> MediaError {
        if self.encoder_started.load(Ordering::Relaxed) {
            MediaError::EncoderStall
        } else {
            MediaError::FirstFrameTimeout
        }
    }

    async fn finished(&self) -> Result<(), MediaError> {
        let mut completion = self.completion.subscribe();
        loop {
            if let Some(result) = completion.borrow_and_update().clone() {
                return result.map_err(MediaError::Shared);
            }
            completion
                .changed()
                .await
                .map_err(|_| MediaError::Startup)?;
        }
    }
}

struct Membership {
    source: Arc<Source>,
    id: Option<u64>,
}

impl Membership {
    fn detach(mut self) -> bool {
        self.remove()
    }

    fn remove(&mut self) -> bool {
        let Some(id) = self.id.take() else {
            return false;
        };
        let mut members = self
            .source
            .members
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        members.viewers.remove(&id);
        let last = members.viewers.is_empty();
        if last {
            self.source.stopping.store(true, Ordering::Relaxed);
        }
        last
    }
}

impl Drop for Membership {
    fn drop(&mut self) {
        self.remove();
    }
}

async fn deliver(
    source: &Source,
    viewer: &Arc<dyn Viewer>,
    mut packets: broadcast::Receiver<Packet>,
    mut shutdown: watch::Receiver<()>,
    ready: oneshot::Sender<()>,
    audio: bool,
) -> Result<(), MediaError> {
    let mut ready = Some(ready);
    let mut waiting_keyframe = true;
    let deadline = tokio::time::sleep(FIRST_FRAME_TIMEOUT);
    tokio::pin!(deadline);
    loop {
        let packet = tokio::select! {
            biased;
            _ = shutdown.changed() => return Ok(()),
            result = source.finished() => return result,
            _ = &mut deadline, if ready.is_some() => return Err(source.startup_error()),
            packet = packets.recv() => match packet {
                Ok(packet) => packet,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    // Dropping independent audio/video samples would skew this peer's
                    // RTP clocks. Only silent previews recover by discarding deltas.
                    if audio {
                        return Err(MediaError::Transport("desktop media delivery fell behind".to_owned()));
                    }
                    // Discard the remaining dependent frames; recover at a fresh IDR.
                    packets = packets.resubscribe();
                    waiting_keyframe = true;
                    source.keyframe.store(true, Ordering::Relaxed);
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
            },
        };
        let video = matches!(&packet, Packet::Video(..));
        if waiting_keyframe {
            if !matches!(&packet, Packet::Video(_, _, _, true)) {
                continue;
            }
            waiting_keyframe = false;
        }
        tokio::select! {
            biased;
            _ = shutdown.changed() => return Ok(()),
            result = source.finished() => return result,
            _ = &mut deadline, if ready.is_some() => {
                return Err(MediaError::Transport("desktop media delivery did not start within 30 seconds".to_owned()));
            }
            result = viewer.write(packet) => result?,
        }
        if video && let Some(ready) = ready.take() {
            let _ = ready.send(());
        }
    }
}

#[cfg(test)]
mod tests;
