//! Test-only peer for `mise run desktop:smoke-media`.
//! Set DESKFLEET_SMOKE_CAPTURE=1 to stream the first display instead of the fixture.

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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let capture = std::env::var("DESKFLEET_SMOKE_CAPTURE").as_deref() == Ok("1");
    let peer = Arc::new(
        Peer::new(PeerConfig {
            video: Some(VideoCodec::H264),
            audio: !capture,
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
    let frame = Bytes::from_static(include_bytes!("fixtures/red-64x64.h264"));
    let mut ticks = tokio::time::interval(Duration::from_millis(100));
    let mut connected = false;
    let mut desktop = None;
    let mut starting = None;
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
                        if capture && connected && desktop.is_none() && starting.is_none() {
                            let peer = Arc::clone(&peer);
                            // Keep consuming ICE, DataChannel, and error events while the
                            // capture worker waits for its first encoded packet.
                            starting = Some(tokio::spawn(async move {
                                let display = media::displays().await?.into_iter().next()
                                    .ok_or(MediaError::InvalidConfig("no display available for media smoke"))?;
                                DesktopStream::start(peer, DesktopConfig {
                                    display_id: display.id,
                                    fps: 30.0,
                                    bitrate_bps: 8_000_000,
                                    max_bitrate_bps: 0,
                                }).await
                            }));
                        }
                        if state == PeerState::Failed {
                            return Err("native peer connection failed".into());
                        }
                    }
                    Some(PeerEvent::Data { label, data, is_string }) => {
                        if is_string {
                            peer.send_text(&label, std::str::from_utf8(&data)?).await?;
                        } else {
                            peer.send_data(&label, data).await?;
                        }
                    }
                    Some(PeerEvent::Error(error)) => return Err(error.into()),
                    None => break,
                    _ => {},
                },
                started = async { starting.as_mut().expect("guarded capture startup").await }, if starting.is_some() => {
                    starting.take();
                    desktop = Some(started??);
                },
                _ = ticks.tick(), if connected && !capture => {
                    peer.write_video(frame.clone(), Duration::from_millis(100)).await?;
                    // One valid 20 ms Opus silence packet, repeated five times per tick.
                    for _ in 0..5 {
                        peer.write_audio(Bytes::from_static(&[0xf8, 0xff, 0xfe]), Duration::from_millis(20)).await?;
                    }
                },
            }
        }
        Ok(())
    }.await;
    // A pending startup also owns a worker, so join it before closing the peer.
    let stopped: Result<(), Box<dyn std::error::Error>> = async {
        if let Some(starting) = starting {
            desktop = Some(starting.await??);
        }
        if let Some(desktop) = desktop {
            desktop.stop().await?;
        }
        Ok(())
    }
    .await;
    let closed = peer.close().await;
    result?;
    stopped?;
    closed?;
    Ok(())
}
