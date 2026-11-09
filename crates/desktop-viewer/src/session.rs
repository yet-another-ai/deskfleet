//! Control/signaling and transport never wait for the window's presentation queue.

#[cfg(any(
    target_os = "linux",
    target_os = "windows",
    target_os = "macos",
    target_os = "android",
    target_os = "ios"
))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(any(
    target_os = "linux",
    target_os = "windows",
    target_os = "macos",
    target_os = "android",
    target_os = "ios"
))]
use std::time::{Duration, Instant};

use deskfleet_input::InputEvent;
use deskfleet_native::rtc::{Peer, PeerConfig, PeerEvent, PeerState, VideoCodec, VideoReceiver};
use serde_json::json;
use tokio::sync::{mpsc, watch};

use crate::input_queue;
use crate::protocol::{self, Candidate, Command};
use crate::queue::FrameQueue;
use crate::{Error, Frame, WindowEvent, WindowNotifier};

pub(crate) type Frames = Arc<Mutex<FrameQueue<Frame>>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PeerExit {
    Stop,
    Close,
}

/// A consumed lifecycle command must survive an error reported during teardown.
pub(crate) struct PeerOutcome {
    pub(crate) exit: Option<PeerExit>,
    pub(crate) result: Result<(), Error>,
}

pub(crate) async fn run(
    commands: mpsc::Receiver<Command>,
    input: input_queue::Receiver,
    frames: Frames,
    proxy: WindowNotifier,
    shutdown: watch::Receiver<bool>,
) -> Result<(), Error> {
    crate::session_manager::run(commands, input, frames, proxy, shutdown).await
}

pub(crate) async fn run_peer(
    start: Command,
    codecs: &[VideoCodec],
    commands: &mut mpsc::Receiver<Command>,
    input: &mut input_queue::Receiver,
    frames: Frames,
    proxy: WindowNotifier,
    mut shutdown: watch::Receiver<bool>,
) -> PeerOutcome {
    let mut exit = None;
    let result = async {
        let Command::Start {
            title,
            ice_servers,
            relay_only,
            mut control,
            codec,
            width,
            height,
        } = start
        else {
            return Err("expected viewer start command".into());
        };
        let codec = VideoCodec::from(codec);
        if !codecs.contains(&codec) || width == 0 || height == 0 {
            return Err("unsupported viewer codec or invalid display dimensions".into());
        }
        let peer = Arc::new(
            Peer::new_video_receiver(PeerConfig {
                video: Some(codec),
                audio: false,
                relay_only,
                ice_servers: ice_servers.into_iter().map(Into::into).collect(),
            })
            .await?,
        );
        let result: Result<(), Error> = async {
            // Negotiate input once so the settings checkbox can enable it without
            // interrupting the video. Authorization still gates every input event.
            peer.create_data_channel("deskfleet-input".into()).await?;
            let offer = peer.create_offer().await?;
            protocol::emit(json!({"type":"offer", "sdp":offer}))?;
            let receiver = peer.take_video_receiver()?;
            let decode_proxy = proxy.clone();
            let (decode_stop, mut decode_shutdown) = watch::channel(false);
            let decode = tokio::spawn(async move {
                let result = receive(receiver, frames, decode_proxy.clone(), &mut decode_shutdown, width, height).await;
                if let Err(error) = &result {
                    let _ = protocol::emit(json!({"type":"error", "reason":"decoder", "error":error.to_string()}));
                }
                result
            });
            let _ = proxy.send_event(WindowEvent::Start {
                title,
                control,
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                codec: codec.into(),
            });
            let mut input_open = false;
            let mut input_ready = false;
            let mut configuration = crate::input_configuration::Configuration::default();
            let mut deferred_configuration = None;
            let mut answered = false;
            let mut connected = false;
            let loop_result: Result<(), Error> = async {
                loop {
                    tokio::select! {
                        _ = shutdown.changed() => { exit = Some(PeerExit::Close); break; },
                        command = commands.recv() => match command {
                            Some(Command::Answer { sdp }) => {
                                if answered { return Err("viewer already applied an answer".into()); }
                                peer.accept_answer(sdp).await?;
                                answered = true;
                                protocol::emit(json!({"type":"answerApplied"}))?;
                            },
                            Some(Command::Candidate { candidate }) => peer.add_ice_candidate(candidate.into()).await?,
                            Some(Command::Close) | None => { exit = Some(PeerExit::Close); break; },
                            Some(Command::Stop) => { exit = Some(PeerExit::Stop); break; },
                            Some(Command::SetControl { control: enabled }) => {
                                // Always release before changing authorization on the ordered channel.
                                if input_open {
                                    peer.send_text("deskfleet-input", &serde_json::to_string(&InputEvent::ReleaseAll)?).await?;
                                }
                                control = false;
                                let message = configuration.request(enabled)?;
                                if input_open {
                                    peer.send_text("deskfleet-input", &message).await?;
                                } else {
                                    deferred_configuration = Some(message);
                                }
                            },
                            Some(Command::Ui { state }) => crate::session_manager::ui(&proxy, state),
                            Some(Command::Start { .. }) => return Err("viewer already started".into()),
                        },
                        event = input.recv() => {
                            if let Some(event) = event? {
                                if control && input_open && input_ready {
                                    peer.send_text("deskfleet-input", &serde_json::to_string(&event)?).await?;
                                }
                            } else { break; }
                        },
                        _ = tokio::time::sleep_until(configuration.deadline()), if configuration.pending() => {
                            configuration.timeout()?;
                            deferred_configuration = None;
                            control = false;
                        },
                        event = peer.next_event() => match event? {
                            Some(PeerEvent::IceCandidate(Some(candidate))) => {
                                protocol::emit(json!({"type":"candidate", "candidate":Candidate::from(candidate)}))?;
                            }
                            Some(PeerEvent::StateChanged(PeerState::Connected)) if !connected => {
                                connected = true;
                                protocol::emit(json!({"type":"connected"}))?;
                                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                                let _ = proxy.send_event(WindowEvent::Connected(true));
                            }
                            Some(PeerEvent::StateChanged(PeerState::Disconnected)) => {
                                connected = false;
                                protocol::emit(json!({"type":"disconnected"}))?;
                                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                                let _ = proxy.send_event(WindowEvent::Connected(false));
                            }
                            Some(PeerEvent::StateChanged(PeerState::Failed | PeerState::Closed)) => {
                                return Err("native WebRTC connection ended".into());
                            }
                            Some(PeerEvent::DataChannelOpen { label }) if label == "deskfleet-input" => {
                                input_open = true;
                                if let Some(message) = deferred_configuration.take() {
                                    peer.send_text("deskfleet-input", &message).await?;
                                }
                            },
                            Some(PeerEvent::DataChannelClosed { label }) if control && label == "deskfleet-input" => {
                                input_open = false;
                                return Err("desktop input channel closed".into());
                            },
                            Some(PeerEvent::Data { label, data, is_string }) if label == "deskfleet-input" => {
                                use crate::input_reply::Reply;
                                match crate::input_reply::parse(&data, is_string)? {
                                    Reply::Ready => {
                                        input_ready = true;
                                        protocol::emit(json!({"type":"inputReady"}))?;
                                        #[cfg(not(any(target_os = "android", target_os = "ios")))]
                                        let _ = proxy.send_event(WindowEvent::InputReady);
                                    }
                                    Reply::Error { error } => return Err(error.into()),
                                    Reply::Configured { request_id, control: enabled } => {
                                        if configuration.reply(request_id, enabled, None)? { control = enabled; input_ready = true; }
                                    }
                                    Reply::ConfigurationError { request_id, control: enabled, error } => {
                                        if configuration.reply(request_id, enabled, Some(error))? { control = enabled; input_ready = true; }
                                    }
                                }
                            },
                            Some(PeerEvent::Error { message, .. }) => return Err(message.into()),
                            None => return Err("native WebRTC connection ended".into()),
                            _ => {},
                        },
                    }
                }
                Ok(())
            }.await;
            if input_open {
                let _ = peer.send_text("deskfleet-input", &serde_json::to_string(&InputEvent::ReleaseAll)?).await;
            }
            decode_stop.send_replace(true);
            let closed = peer.close().await;
            let decoded = decode.await;
            loop_result?;
            closed?;
            decoded??;
            Ok(())
        }.await;
        // Also close if negotiation failed before entering the command loop.
        let closed = peer.close().await;
        result?;
        closed?;
        Ok(())
    }.await;
    PeerOutcome { exit, result }
}

#[cfg(any(
    target_os = "linux",
    target_os = "windows",
    target_os = "macos",
    target_os = "android",
    target_os = "ios"
))]
async fn receive(
    mut receiver: VideoReceiver,
    frames: Frames,
    proxy: WindowNotifier,
    shutdown: &mut watch::Receiver<bool>,
    width: u32,
    height: u32,
) -> Result<(), Error> {
    let codec = receiver.codec();
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    let _ = (width, height);
    let (packets, mut incoming) = mpsc::channel(32);
    let keyframe = Arc::new(AtomicBool::new(false));
    let request = Arc::clone(&keyframe);
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = Arc::clone(&stopped);
    let mut worker = tokio::task::spawn_blocking(move || -> Result<(), Error> {
        let Some(first): Option<deskfleet_native::rtc::ReceivedVideoPacket> =
            incoming.blocking_recv()
        else {
            return Ok(());
        };
        #[cfg(target_os = "linux")]
        let decoder = deskfleet_linux_media::RtpVideoDecoder::with_codec(
            first.payload_type,
            linux_codec(codec),
        )?;
        #[cfg(target_os = "windows")]
        let decoder = crate::windows_decoder::RtpVideoDecoder::with_codec(
            first.payload_type,
            codec,
            width,
            height,
        )?;
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        let decoder = crate::macos_decoder::RtpVideoDecoder::with_codec(first.payload_type, codec)?;
        #[cfg(target_os = "android")]
        let decoder = crate::android_decoder::RtpVideoDecoder::with_codec(
            first.payload_type,
            codec,
            width,
            height,
        )?;
        let mut pending = Some(first);
        let mut announced = false;
        while !stop.load(Ordering::Acquire) {
            if pending.is_none() {
                match incoming.try_recv() {
                    Ok(packet) => pending = Some(packet),
                    Err(mpsc::error::TryRecvError::Disconnected) => break,
                    Err(mpsc::error::TryRecvError::Empty) => {}
                }
            }
            let mut backpressured = false;
            if let Some(packet) = &pending
                && decoder.try_push(&packet.data)?
            {
                pending = None;
            } else if pending.is_some() {
                backpressured = true;
            }
            // Only block waiting for decoded output when no input is immediately pending.
            let timeout = if backpressured || (pending.is_none() && incoming.is_empty()) {
                Duration::from_millis(2)
            } else {
                Duration::ZERO
            };
            if let Some(frame) = decoder.next_frame(timeout)? {
                if !announced {
                    protocol::emit(json!({"type":"videoReady"}))?;
                    announced = true;
                }
                tracing::debug!(
                    width = frame.width,
                    height = frame.height,
                    "viewer frame decoded"
                );
                let notify = {
                    let mut queue = frames.lock().map_err(|_| "decoded queue poisoned")?;
                    let was_empty = queue.is_empty();
                    queue.push(Frame {
                        width: frame.width,
                        height: frame.height,
                        pixels: frame.pixels,
                        ready_at: Instant::now(),
                    });
                    was_empty
                };
                if notify && proxy.send_event(WindowEvent::FrameReady).is_err() {
                    break;
                }
            }
            if decoder.take_keyframe_request() {
                request.store(true, Ordering::Release);
            }
        }
        decoder.stop()?;
        Ok(())
    });
    let mut keyframe_poll = tokio::time::interval(Duration::from_millis(50));
    let mut completed = None;
    let result: Result<(), Error> = async {
        loop {
            tokio::select! {
                _ = shutdown.changed() => break,
                result = &mut worker => { completed = Some(result); break; },
                packet = receiver.next_packet() => match packet? {
                    Some(packet) => {
                        tokio::select! {
                            _ = shutdown.changed() => break,
                            sent = packets.send(packet) => if sent.is_err() { break; },
                        }
                    }
                    None => break,
                },
                _ = keyframe_poll.tick() => {
                    if keyframe.swap(false, Ordering::AcqRel) { receiver.request_keyframe().await?; }
                },
            }
        }
        Ok(())
    }.await;
    stopped.store(true, Ordering::Release);
    drop(packets);
    match completed {
        Some(result) => result??,
        None => worker.await??,
    }
    result
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "windows",
    target_os = "macos",
    target_os = "android",
    target_os = "ios"
)))]
async fn receive(
    _receiver: VideoReceiver,
    _frames: Frames,
    _proxy: WindowNotifier,
    _shutdown: &mut watch::Receiver<bool>,
    _width: u32,
    _height: u32,
) -> Result<(), Error> {
    Err("native desktop decoding is supported on Linux, Windows, macOS, Android, and iOS".into())
}

pub(crate) fn supported_codecs() -> Result<Vec<VideoCodec>, Error> {
    #[cfg(target_os = "windows")]
    {
        crate::windows_decoder::supported_codecs()
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        crate::macos_decoder::supported_codecs()
    }
    #[cfg(target_os = "android")]
    {
        crate::android_decoder::supported_codecs()
    }
    #[cfg(target_os = "linux")]
    {
        Ok(deskfleet_linux_media::supported_decoder_codecs()?
            .into_iter()
            .map(|codec| match codec {
                deskfleet_linux_media::Codec::H264 => VideoCodec::H264,
                deskfleet_linux_media::Codec::H265 => VideoCodec::H265,
                deskfleet_linux_media::Codec::Av1 => VideoCodec::Av1,
            })
            .collect())
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "windows",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    )))]
    {
        Ok(Vec::new())
    }
}

#[cfg(target_os = "linux")]
fn linux_codec(codec: VideoCodec) -> deskfleet_linux_media::Codec {
    match codec {
        VideoCodec::H264 => deskfleet_linux_media::Codec::H264,
        VideoCodec::H265 => deskfleet_linux_media::Codec::H265,
        VideoCodec::Av1 => deskfleet_linux_media::Codec::Av1,
    }
}
