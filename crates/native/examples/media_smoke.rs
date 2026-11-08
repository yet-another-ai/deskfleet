//! Test-only peer for `mise run desktop:smoke-media`.
//! Set DESKFLEET_SMOKE_CAPTURE=1 to stream the first display instead of the fixture.
//! Set DESKFLEET_SMOKE_HARDWARE=1 and DESKFLEET_SMOKE_CODEC to encode generated pixels.
//! Set DESKFLEET_SMOKE_WINDOWS_SERVICE=1 to require the installed service for capture.
//! Set DESKFLEET_SMOKE_REPORT_INPUT=1 to report received input as JSON without OS injection.

#[path = "media_smoke/hardware.rs"]
mod hardware;

use std::io::{self, BufRead};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use deskfleet_native::media::{self, DesktopConfig, DesktopStream, MediaError};
use deskfleet_native::rtc::{IceCandidate, Peer, PeerConfig, PeerEvent, PeerState, VideoCodec};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Command {
    Offer { sdp: String },
    Candidate { candidate: Candidate },
    Close,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    candidate: String,
    sdp_mid: Option<String>,
    #[serde(rename = "sdpMLineIndex")]
    sdp_mline_index: Option<u16>,
    username_fragment: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum FixtureInput {
    Event(deskfleet_input::InputEvent),
    Settings(FixtureSettings),
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum FixtureSettings {
    Configure {
        #[serde(rename = "requestId")]
        request_id: u64,
        control: bool,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let capture = std::env::var("DESKFLEET_SMOKE_CAPTURE").as_deref() == Ok("1");
    let hardware = std::env::var("DESKFLEET_SMOKE_HARDWARE").as_deref() == Ok("1");
    let report_input = std::env::var("DESKFLEET_SMOKE_REPORT_INPUT").as_deref() == Ok("1");
    let audio =
        !capture && !hardware && std::env::var("DESKFLEET_SMOKE_VIDEO_ONLY").as_deref() != Ok("1");
    let require_service = std::env::var("DESKFLEET_SMOKE_WINDOWS_SERVICE").as_deref() == Ok("1");
    if require_service && (!capture || !cfg!(windows)) {
        return Err("Windows service smoke requires capture mode on Windows".into());
    }
    #[cfg(windows)]
    if require_service {
        let status = deskfleet_windows_desktop::status()?;
        if !status.installed || !status.running {
            return Err("Windows service smoke requires the running desktop service".into());
        }
    }
    let codec = match std::env::var("DESKFLEET_SMOKE_CODEC")
        .as_deref()
        .unwrap_or("h264")
    {
        "h264" => VideoCodec::H264,
        "h265" => VideoCodec::H265,
        "av1" => VideoCodec::Av1,
        _ => return Err("DESKFLEET_SMOKE_CODEC must be h264, h265 or av1".into()),
    };
    if capture && hardware {
        return Err("select either capture or hardware smoke".into());
    }
    let peer = Arc::new(
        Peer::new(PeerConfig {
            video: Some(codec),
            audio,
            ..Default::default()
        })
        .await?,
    );
    let (sender, mut commands) = mpsc::channel(8);
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let parsed = line
                .map_err(|error| error.to_string())
                .and_then(|line| serde_json::from_str(&line).map_err(|error| error.to_string()));
            if sender.blocking_send(parsed).is_err() {
                break;
            }
        }
    });
    // Every sample is a complete SPS/PPS/IDR access unit, so repeating it is valid.
    let frame = Bytes::from_static(match codec {
        VideoCodec::H264 => include_bytes!("fixtures/red-64x64.h264"),
        VideoCodec::H265 => include_bytes!("fixtures/red-64x64.h265"),
        VideoCodec::Av1 => include_bytes!("fixtures/red-64x64.av1"),
    });
    let mut ticks = tokio::time::interval(Duration::from_millis(100));
    let mut connected = false;
    let mut desktop = None;
    let mut starting = None;
    let mut hardware_stream: Option<hardware::HardwareStream> = None;
    // The normal fixture never opens a desktop permission dialog. On Linux a
    // real capture smoke deliberately follows daemon startup authorization,
    // while continuing to consume close/signaling commands during consent.
    let mut authorizing =
        (capture && cfg!(target_os = "linux")).then(|| tokio::spawn(authorize_linux_capture()));
    let mut authorized = authorizing.is_none();
    println!("{}", json!({ "kind": "ready" }));
    let result: Result<(), Box<dyn std::error::Error>> = async {
        loop {
            tokio::select! {
                command = commands.recv() => match command {
                    Some(Ok(Command::Offer { sdp })) => {
                        let answer = peer.answer_offer(sdp).await?;
                        println!("{}", json!({ "kind": "answer", "sdp": answer }));
                    }
                    Some(Ok(Command::Candidate { candidate })) => {
                        peer.add_ice_candidate(IceCandidate {
                            candidate: candidate.candidate,
                            sdp_mid: candidate.sdp_mid,
                            sdp_mline_index: candidate.sdp_mline_index,
                            username_fragment: candidate.username_fragment,
                        }).await?;
                    }
                    Some(Ok(Command::Close)) | None => break,
                    Some(Err(error)) => return Err(error.into()),
                },
                event = peer.next_event() => match event? {
                    Some(PeerEvent::IceCandidate(Some(candidate))) => {
                        println!("{}", json!({ "kind": "candidate", "candidate": {
                            "candidate": candidate.candidate,
                            // Chromium resolves a null mid using the media index.
                            "sdpMid": candidate.sdp_mid.filter(|mid| !mid.is_empty()),
                            "sdpMLineIndex": candidate.sdp_mline_index,
                            "usernameFragment": candidate.username_fragment,
                        }}));
                    }
                    Some(PeerEvent::StateChanged(state)) => {
                        connected = state == PeerState::Connected;
                        if state == PeerState::Failed {
                            return Err("native peer connection failed".into());
                        }
                    }
                    Some(PeerEvent::DataChannelOpen { label }) if label == "deskfleet-input" => {
                        // Protocol fixture only: acknowledge readiness without attaching
                        // an OS controller or injecting any keyboard/pointer input.
                        peer.send_text(&label, r#"{"type":"ready"}"#).await?;
                    }
                    Some(PeerEvent::Data { label, data, is_string }) if label == "deskfleet-input" => {
                        if !is_string { return Err("binary desktop input".into()); }
                        match serde_json::from_slice::<FixtureInput>(&data)? {
                            FixtureInput::Event(event) if report_input => println!("{}", json!({ "kind": "input", "event": event })),
                            FixtureInput::Event(_) => {},
                            FixtureInput::Settings(FixtureSettings::Configure { request_id, control }) => {
                                peer.send_text(&label, &json!({"type":"configured", "requestId":request_id, "control":control}).to_string()).await?;
                            }
                        }
                    }
                    Some(PeerEvent::Data { label, data, is_string }) => {
                        if is_string {
                            peer.send_text(&label, std::str::from_utf8(&data)?).await?;
                        } else {
                            peer.send_data(&label, data).await?;
                        }
                    }
                    Some(PeerEvent::Error { message, .. }) => return Err(message.into()),
                    Some(PeerEvent::KeyframeRequested) => {
                        if let Some(stream) = hardware_stream.as_ref() { stream.request_keyframe(); }
                    }
                    None => break,
                    _ => {},
                },
                started = async { starting.as_mut().expect("guarded capture startup").await }, if starting.is_some() => {
                    starting.take();
                    desktop = Some(started??);
                },
                granted = async { authorizing.as_mut().expect("guarded authorization").await }, if authorizing.is_some() => {
                    authorizing.take();
                    granted??;
                    authorized = true;
                },
                packet = async { hardware_stream.as_mut().expect("guarded hardware stream").next_packet().await }, if hardware_stream.is_some() => {
                    let packet = packet?;
                    peer.write_video(packet.data.into(), packet.duration).await?;
                },
                _ = ticks.tick(), if connected && !capture && !hardware => {
                    peer.write_video(frame.clone(), Duration::from_millis(100)).await?;
                    // One valid 20 ms Opus silence packet, repeated five times per tick.
                    if audio {
                        for _ in 0..5 {
                            peer.write_audio(Bytes::from_static(&[0xf8, 0xff, 0xfe]), Duration::from_millis(20)).await?;
                        }
                    }
                },
            }
            if hardware && connected && hardware_stream.is_none() {
                hardware_stream = Some(hardware::HardwareStream::start(codec)?);
            }
            if capture && authorized && connected && desktop.is_none() && starting.is_none() {
                let peer = Arc::clone(&peer);
                // Keep consuming commands/events until the first encoded packet.
                starting = Some(tokio::spawn(async move {
                    let display = media::displays().await?.into_iter().next()
                        .ok_or(MediaError::InvalidConfig("no display available for media smoke"))?;
                    #[cfg(any(target_os = "linux", windows))]
                    for _ in 0..2 {
                        // Exercise controller reuse without injecting desktop input.
                        let controller = deskfleet_native::input::InputWorker::start(display.id).await
                            .map_err(|error| deskfleet_capture::CaptureError::Platform(format!("input smoke attach failed: {error}")))?;
                        controller.stop().await
                            .map_err(|error| deskfleet_capture::CaptureError::Platform(format!("input smoke detach failed: {error}")))?;
                    }
                    let preview = std::env::var("DESKFLEET_SMOKE_PREVIEW").is_ok_and(|value| value == "1");
                    DesktopStream::start(peer, DesktopConfig {
                        display_id: display.id,
                        fps: if preview { 1.0 } else { 30.0 },
                        bitrate_bps: if preview { 150_000 } else { 8_000_000 },
                        max_bitrate_bps: 0,
                        max_width: preview.then_some(320),
                        max_height: preview.then_some(180),
                    }).await
                }));
            }
        }
        Ok(())
    }.await;
    // A pending startup also owns a worker, so join it before closing the peer.
    let stopped: Result<(), Box<dyn std::error::Error>> = async {
        if let Some(stream) = hardware_stream {
            stream.stop().await?;
        }
        if let Some(authorizing) = authorizing {
            authorizing.abort();
            let _ = authorizing.await;
        }
        if let Some(starting) = starting {
            desktop = Some(starting.await??);
        }
        if let Some(desktop) = desktop {
            desktop.stop().await?;
        }
        Ok(())
    }
    .await;
    // Also cancels a portal request whose awaiting task was aborted above. Do
    // this even when capture startup/cleanup failed so no consent dialog remains.
    let access_closed = if capture {
        deskfleet_native::desktop_access::close_linux().await
    } else {
        Ok(())
    };
    let closed = peer.close().await;
    result?;
    stopped?;
    access_closed?;
    closed?;
    Ok(())
}

async fn authorize_linux_capture() -> Result<(), MediaError> {
    #[cfg(target_os = "linux")]
    {
        let directory = if deskfleet_native::desktop_access::linux_backend() == Some("wayland") {
            std::env::var("DESKFLEET_SMOKE_PORTAL_DIRECTORY").map_err(|_| {
                MediaError::InvalidConfig("media smoke needs a private temporary portal directory")
            })?
        } else {
            String::new()
        };
        let access = deskfleet_native::desktop_access::request_linux(directory)
            .await
            .map_err(|error| deskfleet_capture::CaptureError::Platform(error.to_string()))?;
        if !access.screen_capture {
            return Err(deskfleet_capture::CaptureError::PermissionDenied.into());
        }
    }
    Ok(())
}
