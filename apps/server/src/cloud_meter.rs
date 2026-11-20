//! Project cloud model usage from the private eve service's durable root-session streams.
use crate::cloud_agent::EveClient;
use crate::error::{ApiError, Result};
use chrono::{DateTime, Utc};
use deskfleet_control_store::{CloudMeterCursor, ControlStore, billing::CloudTokenEvent, now_ms};
use futures_util::{StreamExt, stream};
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;
use tokio::task::JoinHandle;

pub(crate) struct Collector(JoinHandle<()>);

impl Drop for Collector {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(crate) fn start(store: ControlStore, eve: EveClient) -> Collector {
    Collector(tokio::spawn(async move {
        let claims = stream::unfold(&store, |store| async move {
            loop {
                match store.claim_cloud_meter(30_000).await {
                    Ok(Some(cursor)) => return Some((cursor, store)),
                    Ok(None) => tokio::time::sleep(Duration::from_secs(1)).await,
                    Err(error) => {
                        tracing::warn!(%error, "cloud token queue unavailable");
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
            }
        });
        let (store, eve) = (&store, &eve);
        claims.for_each_concurrent(8, |cursor| async move {
            if let Err(error) = collect(store, eve, &cursor).await {
                // The claim expires. Redelivery uses the original stream positions.
                tracing::warn!(%error, session_id = %cursor.session_id, "cloud token collection will retry");
            }
        }).await;
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: Option<i64>,
    cache_write_tokens: Option<i64>,
}

#[derive(Deserialize)]
struct Usage {
    usage: Tokens,
}

struct StoredLine {
    events: Vec<CloudTokenEvent>,
    ended: bool,
}

enum StreamLine {
    Stored(StoredLine),
    Position(i64),
    End,
    OtherTransport,
}

// Transport frames have no durable position. Both progress and fact records occupy a line.
fn parse_line(bytes: &[u8], session_id: &str, line: i64) -> Result<StreamLine> {
    fn invalid() -> ApiError {
        ApiError::bad("invalid eve metering stream record")
    }
    let record: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if let Some(transport) = record.get("$eve") {
        return match transport.as_str() {
            Some("position") => record["next"]
                .as_i64()
                .filter(|next| *next >= 0)
                .map(StreamLine::Position)
                .ok_or_else(invalid),
            Some("stream.ended" | "stream.lease-ended") => Ok(StreamLine::End),
            Some(_) => Ok(StreamLine::OtherTransport),
            None => Err(invalid()),
        };
    }
    let mut stored = StoredLine {
        events: Vec::new(),
        ended: false,
    };
    if record.get("progress").is_some() {
        return Ok(StreamLine::Stored(stored));
    }
    let at: DateTime<Utc> = record["at"]
        .as_str()
        .ok_or_else(invalid)?
        .parse()
        .map_err(|_| invalid())?;
    for (index, fact) in record["facts"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .enumerate()
    {
        match fact["type"].as_str().ok_or_else(invalid)? {
            "usage.recorded" => {
                let usage: Usage =
                    serde_json::from_value(fact["data"].clone()).map_err(|_| invalid())?;
                stored.events.push(CloudTokenEvent {
                    session_id: session_id.to_owned(),
                    line,
                    index: i32::try_from(index).map_err(|_| invalid())?,
                    occurred_at: at.timestamp_millis(),
                    model: None,
                    input_tokens: usage.usage.input_tokens,
                    output_tokens: usage.usage.output_tokens,
                    cached_read_tokens: usage.usage.cache_read_tokens,
                    cached_write_tokens: usage.usage.cache_write_tokens,
                });
            }
            "session.ended" => stored.ended = true,
            _ => {}
        }
    }
    Ok(StreamLine::Stored(stored))
}

fn upstream_error(_: reqwest::Error) -> ApiError {
    ApiError::bad("could not read eve metering stream")
}

async fn collect(store: &ControlStore, eve: &EveClient, cursor: &CloudMeterCursor) -> Result<()> {
    const BATCH_LINES: i64 = 256;
    let mut response = eve
        .get(&["eve", "v1", "session", &cursor.session_id, "stream"])?
        .query(&[
            ("startIndex", cursor.next_line.to_string()),
            ("follow", "false".to_owned()),
        ])
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(upstream_error)?
        .error_for_status()
        .map_err(upstream_error)?;
    let headers = response.headers();
    if headers
        .get("x-eve-stream-version")
        .and_then(|v| v.to_str().ok())
        != Some("27")
    {
        return Err(ApiError::bad("unsupported eve metering stream version"));
    }
    let tail = headers
        .get("x-eve-stream-tail-index")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= -1 && *v < i64::MAX)
        .ok_or_else(|| ApiError::bad("eve metering stream missing tail"))?;
    let mut line = cursor.next_line;
    let mut ended = false;
    let mut terminated = false;
    let mut buffer = Vec::new();
    'chunks: while let Some(chunk) = response.chunk().await.map_err(upstream_error)? {
        for part in chunk.split_inclusive(|&b| b == b'\n') {
            if buffer.len() + part.len() > 16 * 1024 * 1024 {
                return Err(ApiError::bad("oversized eve metering stream record"));
            }
            buffer.extend_from_slice(part);
            if !part.ends_with(b"\n") {
                continue;
            }
            match parse_line(&buffer, &cursor.session_id, line)? {
                StreamLine::Stored(stored) => {
                    if line > tail {
                        return Err(ApiError::bad("eve stream exceeded bounded tail"));
                    }
                    for event in stored.events {
                        store
                            .record_cloud_token_usage(&cursor.team_id, &event)
                            .await?;
                    }
                    line += 1;
                    ended |= stored.ended;
                }
                StreamLine::Position(next) => {
                    if next > tail + 1 {
                        return Err(ApiError::bad("eve stream exceeded bounded tail"));
                    }
                    line = line.max(next);
                }
                StreamLine::End => terminated = true,
                StreamLine::OtherTransport => {}
            }
            buffer.clear();
            if line - cursor.next_line >= BATCH_LINES {
                break 'chunks;
            }
        }
    }
    // A finite reader can finish before its separately sampled tail, or its
    // upstream lease can expire. Persist the prefix and claim the next read.
    if !buffer.is_empty() || (!terminated && line <= tail && line - cursor.next_line < BATCH_LINES)
    {
        return Err(ApiError::bad("incomplete eve metering stream"));
    }
    let next_poll = if ended && line > tail {
        None
    } else if line <= tail {
        Some(now_ms())
    } else if line > cursor.next_line {
        Some(now_ms() + 2_000)
    } else {
        // Back off quiet sessions. New deliveries immediately re-arm collection.
        let now = now_ms();
        let idle = now.saturating_sub(cursor.last_active_at);
        Some(now + (idle / 2).clamp(2_000, 15 * 60_000))
    };
    store.finish_cloud_meter(cursor, line, next_poll).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_preserves_optional_cache_breakdowns() {
        let line = br#"{"at":"2026-11-21T00:00:00Z","facts":[
            {"type":"usage.recorded","data":{"usage":{"inputTokens":8,"outputTokens":2}}},
            {"type":"usage.recorded","data":{"usage":{"inputTokens":8,"outputTokens":2,"cacheReadTokens":null,"cacheWriteTokens":0}}},
            {"type":"usage.recorded","data":{"usage":{"inputTokens":8,"outputTokens":2,"cacheReadTokens":5,"cacheWriteTokens":2}}}
        ]}"#;
        let StreamLine::Stored(record) = parse_line(line, "s", 7).unwrap() else {
            panic!("expected stored usage")
        };
        let caches: Vec<_> = record
            .events
            .iter()
            .map(|event| (event.cached_read_tokens, event.cached_write_tokens))
            .collect();
        assert_eq!(caches, [(None, None), (None, Some(0)), (Some(5), Some(2))]);
    }

    #[test]
    fn stream_positions_count_progress_and_multiple_facts_but_exclude_transport() {
        assert!(matches!(
            parse_line(br#"{"$eve":"heartbeat"}"#, "s", 6).unwrap(),
            StreamLine::OtherTransport
        ));
        assert!(matches!(
            parse_line(br#"{"$eve":"position","next":12}"#, "s", 6).unwrap(),
            StreamLine::Position(12)
        ));
        for bytes in [
            br#"{"$eve":"stream.ended"}"#.as_slice(),
            br#"{"$eve":"stream.lease-ended"}"#.as_slice(),
        ] {
            assert!(matches!(
                parse_line(bytes, "s", 6).unwrap(),
                StreamLine::End
            ));
        }
        assert!(
            matches!(parse_line(br#"{"progress":{}}"#, "s", 6).unwrap(), StreamLine::Stored(line) if line.events.is_empty())
        );
        let line = br#"{"at":"2026-11-21T00:00:00Z","facts":[{"type":"model.settled"},{"type":"usage.recorded","data":{"usage":{"inputTokens":10,"outputTokens":4,"cacheReadTokens":3,"cacheWriteTokens":1}}},{"type":"session.ended"}]}"#;
        let StreamLine::Stored(record) = parse_line(line, "s", 7).unwrap() else {
            panic!("expected stored usage")
        };
        assert!(record.ended);
        let event = &record.events[0];
        assert_eq!(
            (
                event.line,
                event.index,
                event.input_tokens,
                event.output_tokens
            ),
            (7, 1, 10, 4)
        );
        assert!(
            parse_line(
                br#"{"at":"2026-11-21T00:00:00Z","facts":[{"type":"usage.recorded","data":{}}]}"#,
                "s",
                8
            )
            .is_err()
        );
    }
}
