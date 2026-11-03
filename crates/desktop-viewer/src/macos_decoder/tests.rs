use super::*;

#[test]
fn annex_b_becomes_length_prefixed_without_parameter_sets() {
    let mut parameters = buffers::Parameters::default();
    let picture = parameters
        .picture(&[0, 0, 0, 1, 0x67, 1, 0, 0, 1, 0x68, 2, 0, 0, 1, 0x65, 3])
        .unwrap();
    assert!(picture.changed && picture.idr && picture.has_slice);
    assert_eq!(picture.avcc, [0, 0, 0, 2, 0x65, 3]);
    let repeated = parameters
        .picture(&[0, 0, 0, 1, 0x67, 1, 0, 0, 1, 0x68, 2, 0, 0, 1, 0x41, 4])
        .unwrap();
    assert!(!repeated.changed && !repeated.idr && repeated.has_slice);
    assert_eq!(repeated.avcc, [0, 0, 0, 2, 0x41, 4]);
    assert!(parameters.picture(&[0, 0, 1, 0x67, 9]).unwrap().changed);
}

#[test]
fn malformed_annex_b_is_rejected_without_out_of_bounds_access() {
    for bytes in [
        vec![],
        vec![0, 0],
        vec![0, 0, 1],
        vec![0x65, 1],
        vec![0, 0, 1, 0x65, 0, 0, 1],
    ] {
        assert!(buffers::nals(&bytes).is_err(), "{bytes:?}");
    }
    let escaped = [0, 0, 1, 0x65, 0, 0, 3, 1];
    assert_eq!(buffers::nals(&escaped).unwrap(), [&escaped[3..]]);
}

#[test]
fn callback_bad_data_requests_an_idr_instead_of_a_fatal_error() {
    let output = Output::default();
    // SAFETY: The slot is live for this direct callback invocation, and a
    // failed decode correctly supplies no image buffer.
    unsafe {
        output_callback(
            ptr::from_ref(&output).cast_mut().cast(),
            ptr::null_mut(),
            kVTVideoDecoderBadDataErr,
            VTDecodeInfoFlags::empty(),
            ptr::null_mut(),
            buffers::INVALID_TIME,
            buffers::INVALID_TIME,
        );
    }
    let decoded = output.lock().unwrap().take().unwrap();
    assert_eq!(decoded.status, kVTVideoDecoderBadDataErr);
    let decoder = RtpVideoDecoder::new(96).unwrap();
    decoder.take_keyframe_request();
    assert!(decoder.0.borrow_mut().recover_bad_data(decoded.status));
    assert!(decoder.take_keyframe_request());
    assert!(!decoder.take_keyframe_request());
    assert!(
        decoder
            .0
            .borrow_mut()
            .decode(&[0, 0, 1, 0x41, 1], 0)
            .unwrap()
            .is_none()
    );
}

fn push_picture(decoder: &RtpVideoDecoder, bytes: &[u8], sequence: &mut u16, timestamp: u32) {
    let nals = buffers::nals(bytes).unwrap();
    for (index, nal) in nals.iter().enumerate() {
        assert!(nal.len() < 65535);
        let marker = index + 1 == nals.len();
        let mut packet = vec![0x80, 96 | if marker { 128 } else { 0 }];
        packet.extend(sequence.to_be_bytes());
        packet.extend(timestamp.to_be_bytes());
        packet.extend(1_u32.to_be_bytes());
        packet.extend_from_slice(nal);
        *sequence = sequence.wrapping_add(1);
        assert!(decoder.try_push(&packet).unwrap());
    }
}

fn assert_red(frame: &Frame, size: (u32, u32)) {
    assert_eq!((frame.width, frame.height), size);
    assert_eq!(frame.pixels.len(), size.0 as usize * size.1 as usize * 4);
    for pixel in frame.pixels.as_chunks::<4>().0 {
        assert!(
            pixel[0] > 230 && pixel[1] < 20 && pixel[2] < 20,
            "red RGBA: {pixel:?}"
        );
        assert_eq!(pixel[3], 255);
    }
}

#[test]
#[ignore = "requires a working VideoToolbox H.264 decoder (or explicit software diagnostic)"]
fn runtime_delivers_one_idle_idr_without_eos() {
    let decoder = RtpVideoDecoder::new(96).unwrap();
    push_picture(
        &decoder,
        include_bytes!("../../../native/examples/fixtures/red-64x64.h264"),
        &mut 0,
        0,
    );
    let frame = decoder
        .next_frame(Duration::from_secs(2))
        .unwrap()
        .expect("idle IDR");
    assert_red(&frame, (64, 64));
    assert!(decoder.next_frame(Duration::ZERO).unwrap().is_none());
    decoder.stop().unwrap();
}

#[test]
#[ignore = "requires VideoToolbox H.264 encoding and decoding; synthetic pixels, no capture permission"]
fn runtime_delivers_idle_final_p_and_recreates_session_for_resize() {
    let decoder = RtpVideoDecoder::new(96).unwrap();
    let mut sequence = 65530;
    for (size, timestamp) in [((64, 64), u32::MAX - 1500), ((128, 64), 4500)] {
        let pictures = encoder::pictures(size.0, size.1);
        assert!(
            buffers::nals(&pictures[0])
                .unwrap()
                .iter()
                .any(|nal| nal[0] & 31 == 5)
        );
        assert!(
            buffers::nals(&pictures[1])
                .unwrap()
                .iter()
                .any(|nal| nal[0] & 31 == 1),
            "second picture must be dependent P"
        );
        assert!(
            !buffers::nals(&pictures[1])
                .unwrap()
                .iter()
                .any(|nal| nal[0] & 31 == 5)
        );
        for (index, bytes) in pictures.iter().enumerate() {
            push_picture(
                &decoder,
                bytes,
                &mut sequence,
                timestamp.wrapping_add(index as u32 * 3000),
            );
            let frame = decoder
                .next_frame(Duration::from_secs(2))
                .unwrap()
                .expect("each idle picture must arrive before a subsequent picture or EOS");
            assert_red(&frame, size);
            assert!(decoder.next_frame(Duration::ZERO).unwrap().is_none());
        }
    }
    decoder.stop().unwrap();
}

mod encoder {
    use super::*;
    use objc2_core_media::{
        CMBlockBuffer, CMSampleBuffer, CMVideoFormatDescriptionGetH264ParameterSetAtIndex,
        kCMVideoCodecType_H264,
    };
    use objc2_core_video::{
        CVPixelBufferCreate, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
        CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
    };
    use objc2_video_toolbox::{
        VTCompressionSession, VTEncodeInfoFlags, kVTCompressionPropertyKey_AllowFrameReordering,
        kVTCompressionPropertyKey_AverageBitRate, kVTCompressionPropertyKey_ColorPrimaries,
        kVTCompressionPropertyKey_ProfileLevel, kVTCompressionPropertyKey_RealTime,
        kVTCompressionPropertyKey_TransferFunction, kVTCompressionPropertyKey_YCbCrMatrix,
        kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel,
    };

    type Encoded = Mutex<Vec<Vec<u8>>>;

    /// Test-only encoding uses baseline, no reordering and real-time mode.
    /// Decoder assertions never call FinishDelayedFrames or send an EOS.
    pub fn pictures(width: u32, height: u32) -> Vec<Vec<u8>> {
        let output = Box::new(Encoded::default());
        let mut raw = ptr::null_mut();
        // SAFETY: The callback slot remains valid until the session is
        // invalidated below. The callback copies all sample data into Vecs.
        assert_eq!(
            unsafe {
                VTCompressionSession::create(
                    None,
                    width as i32,
                    height as i32,
                    kCMVideoCodecType_H264,
                    None,
                    None,
                    None,
                    Some(encoded),
                    ptr::from_ref(output.as_ref()).cast_mut().cast(),
                    NonNull::from(&mut raw),
                )
            },
            0
        );
        // SAFETY: Successful Create returns a non-null, owned session.
        let session = unsafe { CFRetained::from_raw(NonNull::new(raw).unwrap()) };
        struct Invalidate<'a>(&'a VTCompressionSession);
        impl Drop for Invalidate<'_> {
            fn drop(&mut self) {
                // SAFETY: The callback slot is still alive during cleanup.
                unsafe { self.0.invalidate() };
            }
        }
        let cleanup = Invalidate(&session);
        // SAFETY: Session and immutable CF constants are live; each property
        // value has its documented CF type.
        unsafe {
            assert_eq!(
                VTSessionSetProperty(
                    session.as_ref(),
                    kVTCompressionPropertyKey_ProfileLevel,
                    Some(kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel.as_ref())
                ),
                0
            );
            assert_eq!(
                VTSessionSetProperty(
                    session.as_ref(),
                    kVTCompressionPropertyKey_AllowFrameReordering,
                    Some(objc2_core_foundation::kCFBooleanFalse.unwrap().as_ref())
                ),
                0
            );
            assert_eq!(
                VTSessionSetProperty(
                    session.as_ref(),
                    kVTCompressionPropertyKey_RealTime,
                    Some(objc2_core_foundation::kCFBooleanTrue.unwrap().as_ref())
                ),
                0
            );
            for (key, value) in [
                (
                    kVTCompressionPropertyKey_ColorPrimaries,
                    objc2_core_video::kCVImageBufferColorPrimaries_ITU_R_709_2,
                ),
                (
                    kVTCompressionPropertyKey_TransferFunction,
                    objc2_core_video::kCVImageBufferTransferFunction_ITU_R_709_2,
                ),
                (
                    kVTCompressionPropertyKey_YCbCrMatrix,
                    objc2_core_video::kCVImageBufferYCbCrMatrix_ITU_R_709_2,
                ),
            ] {
                assert_eq!(
                    VTSessionSetProperty(session.as_ref(), key, Some(value.as_ref())),
                    0
                );
            }
            let bitrate = CFNumber::new_i32(1_000_000);
            assert_eq!(
                VTSessionSetProperty(
                    session.as_ref(),
                    kVTCompressionPropertyKey_AverageBitRate,
                    Some(bitrate.as_ref())
                ),
                0
            );
            assert_eq!(session.prepare_to_encode_frames(), 0);
        }
        let mut pixel = ptr::null_mut();
        // SAFETY: CoreVideo allocates an owned BGRA buffer of the requested size.
        assert_eq!(
            unsafe {
                CVPixelBufferCreate(
                    None,
                    width as usize,
                    height as usize,
                    kCVPixelFormatType_32BGRA,
                    None,
                    NonNull::from(&mut pixel),
                )
            },
            0
        );
        // SAFETY: Successful Create returned a non-null owned buffer.
        let pixel = unsafe { CFRetained::from_raw(NonNull::new(pixel).unwrap()) };
        // SAFETY: We own the buffer exclusively before submitting it to VT;
        // the allocation is written only between matching lock/unlock calls.
        unsafe {
            assert_eq!(
                CVPixelBufferLockBaseAddress(&pixel, CVPixelBufferLockFlags::empty()),
                0
            );
            let stride = CVPixelBufferGetBytesPerRow(&pixel);
            let bytes = std::slice::from_raw_parts_mut(
                CVPixelBufferGetBaseAddress(&pixel).cast::<u8>(),
                stride * height as usize,
            );
            for row in bytes.chunks_exact_mut(stride) {
                for rgba in row[..width as usize * 4].as_chunks_mut::<4>().0 {
                    *rgba = [0, 0, 255, 255];
                }
            }
            assert_eq!(
                CVPixelBufferUnlockBaseAddress(&pixel, CVPixelBufferLockFlags::empty()),
                0
            );
        }
        for index in 0..2 {
            // SAFETY: VT retains the immutable pixel buffer as needed; all
            // sample callbacks finish before the boxed output is consumed.
            unsafe {
                assert_eq!(
                    session.encode_frame(
                        &pixel,
                        CMTime::new(index, 30),
                        CMTime::new(1, 30),
                        None,
                        ptr::null_mut(),
                        ptr::null_mut()
                    ),
                    0
                );
                assert_eq!(session.complete_frames(buffers::INVALID_TIME), 0);
            }
        }
        drop(cleanup);
        let mut output = output.lock().unwrap();
        assert_eq!(output.len(), 2);
        std::mem::take(&mut *output)
    }

    /// # Safety
    /// output is the live boxed Encoded, and VT supplies a live sample on success.
    unsafe extern "C-unwind" fn encoded(
        output: *mut c_void,
        _: *mut c_void,
        status: i32,
        _: VTEncodeInfoFlags,
        sample: *mut CMSampleBuffer,
    ) {
        assert_eq!(status, 0);
        assert!(!sample.is_null());
        // SAFETY: Test encoder retains output through complete_frames and
        // invalidation. The sample is valid for this callback's duration.
        let (output, sample) = unsafe { (&*output.cast::<Encoded>(), &*sample) };
        // SAFETY: Accessors retain valid references from this compressed sample.
        let (format, block) = unsafe {
            (
                sample.format_description().unwrap(),
                sample.data_buffer().unwrap(),
            )
        };
        let mut annex = Vec::new();
        for index in 0..2 {
            let mut pointer = ptr::null();
            let mut length = 0;
            // SAFETY: Format is H.264. These writable outputs receive pointers
            // into the retained format, which are immediately copied.
            assert_eq!(
                unsafe {
                    CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                        &format,
                        index,
                        &raw mut pointer,
                        &raw mut length,
                        ptr::null_mut(),
                        ptr::null_mut(),
                    )
                },
                0
            );
            annex.extend([0, 0, 0, 1]);
            // SAFETY: The successful accessor returned this bounded format data.
            annex.extend_from_slice(unsafe { std::slice::from_raw_parts(pointer, length) });
        }
        // SAFETY: The block is retained for all subsequent reads and copying.
        let mut avcc = vec![0; unsafe { block.data_length() }];
        // SAFETY: Destination has exactly the block's declared length.
        assert_eq!(
            unsafe {
                CMBlockBuffer::copy_data_bytes(
                    &block,
                    0,
                    avcc.len(),
                    NonNull::new(avcc.as_mut_ptr().cast()).unwrap(),
                )
            },
            0
        );
        let mut bytes = avcc.as_slice();
        while !bytes.is_empty() {
            let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
            annex.extend([0, 0, 0, 1]);
            annex.extend_from_slice(&bytes[4..4 + length]);
            bytes = &bytes[4 + length..];
        }
        output.lock().unwrap().push(annex);
    }
}
#[test]
#[ignore = "requires a Mac with hardware HEVC and AV1 decoding"]
fn runtime_decodes_hevc_and_av1_without_following_picture() {
    for (codec, bytes) in [
        (
            deskfleet_native::rtc::VideoCodec::H265,
            include_bytes!("../../../native/examples/fixtures/red-64x64.h265").as_slice(),
        ),
        (
            deskfleet_native::rtc::VideoCodec::Av1,
            include_bytes!("../../../native/examples/fixtures/red-64x64.av1").as_slice(),
        ),
    ] {
        let decoder = super::RtpVideoDecoder::with_codec(96, codec).unwrap();
        let frame = decoder
            .0
            .borrow_mut()
            .decode(bytes, 0)
            .unwrap()
            .expect("idle keyframe");
        assert_eq!((frame.width, frame.height), (64, 64));
        for pixel in frame.pixels.as_chunks::<4>().0 {
            assert!(
                pixel[0] > 230 && pixel[1] < 20 && pixel[2] < 20,
                "{codec:?}: {pixel:?}"
            );
        }
        decoder.stop().unwrap();
    }
}
