use std::collections::HashMap;
use std::sync::Arc;

use bytes::{Bytes, BytesMut};
use tokio::sync::{Mutex, broadcast};
use tokio::task::JoinHandle;
use webrtc::data_channel::{DataChannel, DataChannelEvent, RTCDataChannelState};

use super::{PeerError, PeerEvent, Result};

pub const MAX_DATA_MESSAGE_SIZE: usize = 65_536;
pub(super) const MAX_BUFFERED_AMOUNT: usize = 1_048_576;

pub(super) struct Channel {
    pub(super) rtc: Arc<dyn DataChannel>,
    reader: JoinHandle<()>,
}

impl Drop for Channel {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

pub(super) type Channels = Arc<Mutex<HashMap<String, Channel>>>;

pub(super) async fn register(
    channel: Arc<dyn DataChannel>,
    channels: &Channels,
    events: &broadcast::Sender<PeerEvent>,
) -> Result<()> {
    let label = channel.label().await?;
    let mut map = channels.lock().await;
    if map.contains_key(&label) {
        return Err(PeerError::DuplicateDataChannel(label));
    }

    let reader_channel = Arc::clone(&channel);
    let weak_channels = Arc::downgrade(channels);
    let events = events.clone();
    let reader_label = label.clone();
    let reader = tokio::spawn(async move {
        while let Some(event) = reader_channel.poll().await {
            let event = match event {
                DataChannelEvent::OnOpen => PeerEvent::DataChannelOpen {
                    label: reader_label.clone(),
                },
                DataChannelEvent::OnClose => {
                    if let Some(channels) = weak_channels.upgrade() {
                        channels.lock().await.remove(&reader_label);
                    }
                    let _ = events.send(PeerEvent::DataChannelClosed {
                        label: reader_label.clone(),
                    });
                    return;
                }
                DataChannelEvent::OnMessage(message) => {
                    if message.data.len() > MAX_DATA_MESSAGE_SIZE {
                        PeerEvent::Error(PeerError::MessageTooLarge.to_string())
                    } else {
                        PeerEvent::Data {
                            label: reader_label.clone(),
                            data: message.data.freeze(),
                            is_string: message.is_string,
                        }
                    }
                }
                DataChannelEvent::OnError => {
                    PeerEvent::Error(format!("data channel error: {reader_label}"))
                }
                _ => continue,
            };
            let _ = events.send(event);
        }
        if let Some(channels) = weak_channels.upgrade() {
            channels.lock().await.remove(&reader_label);
        }
    });
    map.insert(
        label,
        Channel {
            rtc: channel,
            reader,
        },
    );
    Ok(())
}

async fn find(channels: &Channels, label: &str, size: usize) -> Result<Arc<dyn DataChannel>> {
    let channel = channels
        .lock()
        .await
        .get(label)
        .map(|channel| Arc::clone(&channel.rtc))
        .ok_or_else(|| PeerError::DataChannelNotOpen(label.to_owned()))?;
    if channel.ready_state().await? != RTCDataChannelState::Open {
        return Err(PeerError::DataChannelNotOpen(label.to_owned()));
    }
    if size > MAX_DATA_MESSAGE_SIZE {
        return Err(PeerError::MessageTooLarge);
    }
    Ok(channel)
}

fn send_error(error: webrtc::error::Error) -> PeerError {
    if matches!(error, webrtc::error::Error::ErrSendBufferFull) {
        PeerError::Backpressure
    } else {
        PeerError::WebRtc(error)
    }
}

pub(super) async fn send_data(channels: &Channels, label: &str, data: &Bytes) -> Result<()> {
    let channel = find(channels, label, data.len()).await?;
    // Upstream checks the configured 1 MiB budget and enqueues under one lock,
    // including sends from concurrent callers.
    channel
        .try_send(BytesMut::from(data.as_ref()))
        .await
        .map_err(send_error)
}

pub(super) async fn send_text(channels: &Channels, label: &str, text: &str) -> Result<()> {
    let channel = find(channels, label, text.len()).await?;
    channel.try_send_text(text).await.map_err(send_error)
}
