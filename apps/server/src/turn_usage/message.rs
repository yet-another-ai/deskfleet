use std::io;

use deskfleet_control_store::{TurnUsage, TurnUsageSide, now_ms};

/// Parse coturn's interval traffic deltas. Final totals are deliberately ignored.
pub(super) fn parse_usage(channel: &str, payload: &str) -> io::Result<Option<TurnUsage>> {
    let (channel, side) = if let Some(channel) = channel.strip_suffix("/traffic/peer") {
        (channel, TurnUsageSide::Peer)
    } else if let Some(channel) = channel.strip_suffix("/traffic") {
        (channel, TurnUsageSide::Client)
    } else {
        return Ok(None);
    };
    let (realm, channel) = if let Some(channel) = channel.strip_prefix("turn/realm/") {
        let Some(parts) = channel.rsplit_once("/user/") else {
            return Ok(None);
        };
        parts
    } else if let Some(channel) = channel.strip_prefix("turn/user/") {
        ("", channel)
    } else {
        return Ok(None);
    };
    let Some((username, allocation_id)) = channel.split_once("/allocation/") else {
        return Ok(None);
    };
    let Some((expires, peer_id)) = username.split_once(':') else {
        return Ok(None);
    };
    if !is_decimal(expires) || expires.parse::<i64>().is_err() {
        return Ok(None);
    }
    let Ok(peer_id) = uuid::Uuid::parse_str(peer_id) else {
        return Ok(None);
    };
    if !is_decimal(allocation_id) || allocation_id.parse::<u64>().is_err() {
        return Err(invalid_usage());
    }

    let payload = payload.strip_prefix("rcvp=").ok_or_else(invalid_usage)?;
    let (received_packets, payload) = payload.split_once(", rcvb=").ok_or_else(invalid_usage)?;
    let (received_bytes, payload) = payload.split_once(", sentp=").ok_or_else(invalid_usage)?;
    let (sent_packets, sent_bytes) = payload.split_once(", sentb=").ok_or_else(invalid_usage)?;
    parse_counter(received_packets)?;
    parse_counter(sent_packets)?;
    let received_bytes = parse_counter(received_bytes)?;
    let sent_bytes = parse_counter(sent_bytes)?;

    Ok(Some(TurnUsage {
        peer_id: peer_id.to_string(),
        realm: realm.to_owned(),
        allocation_id: allocation_id.to_owned(),
        side,
        received_bytes,
        sent_bytes,
        collected_at: now_ms(),
    }))
}

fn is_decimal(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn parse_counter(value: &str) -> io::Result<i64> {
    if !is_decimal(value) {
        return Err(invalid_usage());
    }
    value.parse().map_err(|_| invalid_usage())
}

fn invalid_usage() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid coturn usage message")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEER_ID: &str = "35c596cf-70bb-4a34-a1fb-7958b09b7cc5";
    const CHANNEL: &str = "turn/realm/deskfleet/user/1793188800:35c596cf-70bb-4a34-a1fb-7958b09b7cc5/allocation/000000000000000123/traffic";
    const PAYLOAD: &str = "rcvp=123, rcvb=456, sentp=789, sentb=987";

    #[test]
    fn parses_client_and_peer_directions_with_and_without_a_realm() {
        for (channel, realm, side) in [
            (CHANNEL.to_owned(), "deskfleet", TurnUsageSide::Client),
            (format!("{CHANNEL}/peer"), "deskfleet", TurnUsageSide::Peer),
            (
                CHANNEL.replace("realm/deskfleet/", ""),
                "",
                TurnUsageSide::Client,
            ),
            (
                format!("{CHANNEL}/peer").replace("realm/deskfleet/", ""),
                "",
                TurnUsageSide::Peer,
            ),
        ] {
            let before = now_ms();
            let usage = parse_usage(&channel, PAYLOAD).unwrap().unwrap();
            assert_eq!(usage.peer_id, PEER_ID);
            assert_eq!(usage.realm, realm);
            assert_eq!(usage.allocation_id, "000000000000000123");
            assert_eq!(usage.side, side);
            assert_eq!(usage.received_bytes, 456);
            assert_eq!(usage.sent_bytes, 987);
            assert!((before..=now_ms()).contains(&usage.collected_at));
        }
    }

    #[test]
    fn ignores_totals_status_noise_and_foreign_or_empty_usernames() {
        for channel in [
            String::new(),
            "another-service/traffic".to_owned(),
            CHANNEL.replace("/traffic", "/total_traffic"),
            CHANNEL.replace("/traffic", "/total_traffic/peer"),
            CHANNEL.replace("/traffic", "/status"),
            CHANNEL.replace(&format!("1793188800:{PEER_ID}"), ""),
            CHANNEL.replace(PEER_ID, "another-service"),
            CHANNEL.replace("1793188800", "another-service"),
            CHANNEL.replace(&format!("1793188800:{PEER_ID}"), "foreign-user"),
        ] {
            assert!(
                parse_usage(&channel, "unrelated payload")
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn rejects_malformed_or_out_of_range_counters_without_message_contents() {
        for (old, new) in [
            ("rcvp=123", "rcvp=-1"),
            ("rcvb=456", "rcvb=-456"),
            ("rcvb=456", "rcvb=9223372036854775808"),
            ("sentp=789", "sentp=abc"),
            ("sentb=987", "sentb="),
            ("sentb=987", "sentb=+987"),
            (", rcvb=456", ""),
        ] {
            let error = parse_usage(CHANNEL, &PAYLOAD.replace(old, new)).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            assert_eq!(error.to_string(), "invalid coturn usage message");
        }
        assert!(parse_usage(&CHANNEL.replace("000000000000000123", "bad"), PAYLOAD).is_err());
    }

    #[test]
    fn accepts_zero_deltas_and_largest_storable_byte_count() {
        let payload = PAYLOAD
            .replace("rcvb=456", "rcvb=0")
            .replace("sentb=987", "sentb=9223372036854775807");
        let usage = parse_usage(CHANNEL, &payload).unwrap().unwrap();
        assert_eq!(usage.received_bytes, 0);
        assert_eq!(usage.sent_bytes, i64::MAX);
    }
}
