use windows::Win32::System::Variant::VARIANT;
use windows::core::Result;

/// A rejected optional keyframe request must not prevent submitting its frame.
/// The caller consumes pending input and keyframe state only after input succeeds.
pub(super) fn submit_frame(
    keyframe_requested: bool,
    set_keyframe: impl FnOnce(VARIANT) -> Result<()>,
    process_input: impl FnOnce() -> Result<()>,
) -> Result<()> {
    // CODECAPI_AVEncVideoForceKeyFrame takes ULONG (VT_UI4), not VARIANT_BOOL.
    // It applies to the next ProcessInput and resets after that frame.
    if keyframe_requested && let Err(error) = set_keyframe(VARIANT::from(1u32)) {
        tracing::warn!(%error, "hardware MFT rejected optional keyframe request");
    }
    process_input()
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use windows::Win32::Foundation::{E_INVALIDARG, E_NOTIMPL};
    use windows::Win32::Media::MediaFoundation::MF_E_NOTACCEPTING;
    use windows::Win32::System::Variant::VT_UI4;
    use windows::core::Error;

    use super::*;

    #[test]
    fn rejected_keyframe_request_still_submits_the_frame() {
        for rejection in [E_NOTIMPL, E_INVALIDARG] {
            let submitted = Cell::new(false);
            submit_frame(
                true,
                |value| {
                    assert_eq!(value.vt(), VT_UI4);
                    assert_eq!(u32::try_from(&value).unwrap(), 1);
                    Err(Error::from(rejection))
                },
                || {
                    submitted.set(true);
                    Ok(())
                },
            )
            .unwrap();
            assert!(submitted.get());
        }
    }

    #[test]
    fn input_backpressure_survives_a_rejected_keyframe_request() {
        let requested = Cell::new(0);
        let submitted = Cell::new(0);
        for attempt in 0..2 {
            let result = submit_frame(
                true,
                |_| {
                    requested.set(requested.get() + 1);
                    Err(Error::from(E_NOTIMPL))
                },
                || {
                    submitted.set(submitted.get() + 1);
                    if attempt == 0 {
                        Err(Error::from(MF_E_NOTACCEPTING))
                    } else {
                        Ok(())
                    }
                },
            );
            if attempt == 0 {
                assert_eq!(result.unwrap_err().code(), MF_E_NOTACCEPTING);
            } else {
                result.unwrap();
            }
        }
        assert_eq!(requested.get(), 2);
        assert_eq!(submitted.get(), 2);
    }
}
