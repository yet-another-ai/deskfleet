use std::time::{Duration, Instant};

use crate::{Codec, EncodedPacket, EncoderError};

/// Validate asynchronous hardware startup without draining/ending its session.
pub(super) fn first_packets(
    mut packets: Vec<EncodedPacket>,
    mut poll: impl FnMut() -> Result<Vec<EncodedPacket>, EncoderError>,
    timeout: Duration,
) -> Result<Vec<EncodedPacket>, EncoderError> {
    let deadline = Instant::now() + timeout;
    while packets.is_empty() {
        if Instant::now() >= deadline {
            return Err(EncoderError::Platform(
                "hardware encoder produced no first packet".into(),
            ));
        }
        packets.extend(poll()?);
        if packets.is_empty() {
            std::thread::sleep(
                Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }
    Ok(packets)
}

/// Retry only H.264 startup: selecting x264 must never change the negotiated codec.
pub(super) fn with_software_fallback<T>(
    codec: Codec,
    hardware: impl FnOnce() -> Result<T, EncoderError>,
    software: impl FnOnce() -> Result<T, EncoderError>,
) -> Result<T, EncoderError> {
    match hardware() {
        Ok(value) => Ok(value),
        Err(error) if codec == Codec::H264 => {
            tracing::info!(%error, "hardware startup failed; trying x264 software encoder");
            software().map_err(|software_error| {
                EncoderError::Platform(format!(
                    "no H.264 encoder could start (hardware: {error}; x264: {software_error})"
                ))
            })
        }
        Err(error) => Err(error),
    }
}

pub(super) fn require_h264(codec: Codec) -> Result<(), EncoderError> {
    if codec != Codec::H264 {
        return Err(EncoderError::Unsupported("x264 only encodes H.264"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet() -> EncodedPacket {
        EncodedPacket {
            data: vec![1],
            timestamp_ns: 1234,
            duration_ns: 33_333_333,
            is_keyframe: true,
        }
    }

    #[test]
    fn first_packet_keeps_immediate_output_and_collects_asynchronous_output() {
        let packets = first_packets(
            vec![packet()],
            || panic!("already produced output"),
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(packets[0].timestamp_ns, 1234);

        let mut polls = 0;
        let packets = first_packets(
            Vec::new(),
            || {
                polls += 1;
                Ok(if polls == 2 {
                    vec![packet()]
                } else {
                    Vec::new()
                })
            },
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(polls, 2);
        assert_eq!(packets[0].timestamp_ns, 1234);
    }

    #[test]
    fn asynchronous_startup_error_or_missing_output_tries_software() {
        assert_eq!(
            with_software_fallback(
                Codec::H264,
                || first_packets(
                    Vec::new(),
                    || Err(EncoderError::Unsupported(
                        "hardware failed after submission"
                    )),
                    Duration::from_secs(1),
                ),
                || Ok(vec![packet()]),
            )
            .unwrap()[0]
                .timestamp_ns,
            1234,
        );
        let mut software_called = false;
        with_software_fallback(
            Codec::H264,
            || first_packets(Vec::new(), || panic!("deadline elapsed"), Duration::ZERO),
            || {
                software_called = true;
                Ok(vec![packet()])
            },
        )
        .unwrap();
        assert!(software_called);
    }

    #[test]
    fn software_runs_only_after_h264_hardware_startup_fails() {
        let unexpected = || -> Result<&str, EncoderError> { panic!("unexpected software encoder") };
        for codec in Codec::ALL {
            assert_eq!(
                with_software_fallback(codec, || Ok("hardware"), unexpected).unwrap(),
                "hardware",
            );
        }
        assert_eq!(
            with_software_fallback(
                Codec::H264,
                || Err(EncoderError::Unsupported("hardware unavailable")),
                || Ok("x264"),
            )
            .unwrap(),
            "x264",
        );
        for codec in [Codec::H265, Codec::AV1] {
            let result = with_software_fallback(
                codec,
                || Err(EncoderError::Unsupported("hardware unavailable")),
                unexpected,
            );
            assert!(matches!(
                result,
                Err(EncoderError::Unsupported("hardware unavailable"))
            ));
            assert!(require_h264(codec).is_err());
        }
        assert!(require_h264(Codec::H264).is_ok());
    }

    #[test]
    fn unavailable_software_preserves_both_startup_failures() {
        let error = with_software_fallback::<()>(
            Codec::H264,
            || Err(EncoderError::Platform("hardware unavailable".into())),
            || Err(EncoderError::Platform("x264 unavailable".into())),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("hardware unavailable"));
        assert!(error.contains("x264 unavailable"));
    }
}
