//! Control/signaling and transport never wait for the window's presentation queue.

#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

use deskfleet_input::InputEvent;
use deskfleet_native::rtc::{Peer, PeerConfig, PeerEvent, PeerState, VideoCodec, VideoReceiver};
use serde_json::json;
use tokio::sync::{mpsc, watch};
use winit::event_loop::EventLoopProxy;

use crate::protocol::{self, Candidate, Command};
use crate::queue::FrameQueue;
use crate::{Error, Frame, WindowEvent};

pub(crate) type Frames = Arc<Mutex<FrameQueue<Frame>>>;

pub(crate) async fn run(
    mut commands: mpsc::Receiver<Command>,
    mut input: mpsc::Receiver<InputEvent>,
    frames: Frames,
    proxy: EventLoopProxy<WindowEvent>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), Error> {
    let start = tokio::select! {
        _ = shutdown.changed() => return Ok(()),
        command = commands.recv() => command,
    };
    let Some(Command::Start {
        title,
        ice_servers,
        relay_only,
        control,
    }) = start
    else {
        return Err("expected viewer start command".into());
    };
    let peer = Arc::new(
        Peer::new_video_receiver(PeerConfig {
            video: Some(VideoCodec::H264),
            audio: false,
            relay_only,
            ice_servers: ice_servers.into_iter().map(Into::into).collect(),
        })
        .await?,
    );
    let result = async {
        if control { peer.create_data_channel("deskfleet-input".into()).await?; }
        let receiver = peer.take_video_receiver()?;
        let decode_proxy = proxy.clone();
        let mut decode_shutdown = shutdown.clone();
        let decode = tokio::spawn(async move {
            let result = receive(receiver, frames, decode_proxy.clone(), &mut decode_shutdown).await;
            if let Err(error) = &result {
                let _ = decode_proxy.send_event(WindowEvent::Error(error.to_string()));
            }
            result
        });
        let offer = peer.create_offer().await?;
        protocol::emit(json!({"type":"offer", "sdp":offer}))?;
        let _ = proxy.send_event(WindowEvent::Start { title, control });
        let mut input_open = false;
        let mut connected = false;
        let loop_result: Result<(), Error> = async {
            loop {
                tokio::select! {
                    _ = shutdown.changed() => break,
                    command = commands.recv() => match command {
                        Some(Command::Answer { sdp }) => peer.accept_answer(sdp).await?,
                        Some(Command::Candidate { candidate }) => peer.add_ice_candidate(candidate.into()).await?,
                        Some(Command::Close) | None => break,
                        Some(Command::Start { .. }) => return Err("viewer already started".into()),
                    },
                    event = input.recv(), if control => {
                        if let Some(event) = event {
                            if input_open {
                                peer.send_text("deskfleet-input", &serde_json::to_string(&event)?).await?;
                            }
                        } else { break; }
                    },
                    event = peer.next_event() => match event? {
                        Some(PeerEvent::IceCandidate(Some(candidate))) => {
                            protocol::emit(json!({"type":"candidate", "candidate":Candidate::from(candidate)}))?;
                        }
                        Some(PeerEvent::StateChanged(PeerState::Connected)) if !connected => {
                            connected = true;
                            protocol::emit(json!({"type":"connected"}))?;
                        }
                        Some(PeerEvent::StateChanged(PeerState::Failed | PeerState::Closed)) => {
                            return Err("native WebRTC connection ended".into());
                        }
                        Some(PeerEvent::DataChannelOpen { label }) if label == "deskfleet-input" => input_open = true,
                        Some(PeerEvent::DataChannelClosed { label }) if label == "deskfleet-input" => input_open = false,
                        Some(PeerEvent::Error { message, .. }) => return Err(message.into()),
                        None => break,
                        _ => {},
                    },
                }
            }
            Ok(())
        }.await;
        if input_open {
            let _ = peer.send_text("deskfleet-input", &serde_json::to_string(&InputEvent::ReleaseAll)?).await;
        }
        peer.close().await?;
        decode.await??;
        loop_result
    }.await;
    // Also close if negotiation failed before entering the command loop.
    let closed = peer.close().await;
    result?;
    closed?;
    Ok(())
}

#[cfg(target_os = "linux")]
async fn receive(
    mut receiver: VideoReceiver,
    frames: Frames,
    proxy: EventLoopProxy<WindowEvent>,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(), Error> {
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
        let decoder = deskfleet_linux_media::RtpVideoDecoder::new(first.payload_type)?;
        let mut pending = Some(first);
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

#[cfg(not(target_os = "linux"))]
async fn receive(
    _receiver: VideoReceiver,
    _frames: Frames,
    _proxy: EventLoopProxy<WindowEvent>,
    _shutdown: &mut watch::Receiver<bool>,
) -> Result<(), Error> {
    Err("native desktop decoding is currently supported on Linux".into())
}
