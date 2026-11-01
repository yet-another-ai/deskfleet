use std::env;
use std::path::PathBuf;

fn main() {
    // Build scripts execute on the host, including when checking Windows code
    // from another OS. Select generation using Cargo's target instead.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let header_dir = manifest_dir.join("./include");
    let header = header_dir.join("nvEncodeAPI.h");

    println!("cargo:rerun-if-changed={}", header.display());

    let bindings = bindgen::Builder::default()
        .header(header.to_str().unwrap())
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        // Generate the right calling convention for the target.
        .use_core()
        .wrap_unsafe_ops(true)
        .rust_edition(bindgen::RustEdition::Edition2024)
        // Derive common traits.
        .derive_default(true)
        .derive_debug(true)
        .derive_copy(true)
        // Don't derive Eq/Hash globally — the function table struct has
        // function pointers which produce meaningless comparisons.
        .derive_eq(false)
        .derive_hash(false)
        // Only generate NVENC-related items, plus the GUID/RECT types
        // defined in the header for non-Windows.
        .allowlist_type("_?NV_ENC.*")
        .allowlist_type("_?NVENC.*")
        .allowlist_type("_?GUID")
        .allowlist_type("_?NVENC_RECT")
        .allowlist_type("_?PNVENC.*")
        // Blocklist actual function declarations — we load them via libloading.
        .blocklist_function("NvEncodeAPICreateInstance")
        .blocklist_function("NvEncodeAPIGetMaxSupportedVersion")
        .blocklist_function("NvEncOpenEncodeSession")
        .blocklist_function("NvEncOpenEncodeSessionEx")
        .blocklist_function("NvEncGetEncodeGUIDs")
        .blocklist_function("NvEncGetEncodeGUIDCount")
        .blocklist_function("NvEncGetEncodeProfileGUIDs")
        .blocklist_function("NvEncGetEncodeProfileGUIDCount")
        .blocklist_function("NvEncGetInputFormats")
        .blocklist_function("NvEncGetInputFormatCount")
        .blocklist_function("NvEncGetEncodeCaps")
        .blocklist_function("NvEncGetEncodePresetCount")
        .blocklist_function("NvEncGetEncodePresetGUIDs")
        .blocklist_function("NvEncGetEncodePresetConfig")
        .blocklist_function("NvEncGetEncodePresetConfigEx")
        .blocklist_function("NvEncInitializeEncoder")
        .blocklist_function("NvEncCreateInputBuffer")
        .blocklist_function("NvEncDestroyInputBuffer")
        .blocklist_function("NvEncCreateBitstreamBuffer")
        .blocklist_function("NvEncDestroyBitstreamBuffer")
        .blocklist_function("NvEncEncodePicture")
        .blocklist_function("NvEncLockBitstream")
        .blocklist_function("NvEncUnlockBitstream")
        .blocklist_function("NvEncLockInputBuffer")
        .blocklist_function("NvEncUnlockInputBuffer")
        .blocklist_function("NvEncGetEncodeStats")
        .blocklist_function("NvEncGetSequenceParams")
        .blocklist_function("NvEncGetSequenceParamEx")
        .blocklist_function("NvEncRegisterAsyncEvent")
        .blocklist_function("NvEncUnregisterAsyncEvent")
        .blocklist_function("NvEncMapInputResource")
        .blocklist_function("NvEncUnmapInputResource")
        .blocklist_function("NvEncDestroyEncoder")
        .blocklist_function("NvEncInvalidateRefFrames")
        .blocklist_function("NvEncRegisterResource")
        .blocklist_function("NvEncUnregisterResource")
        .blocklist_function("NvEncReconfigureEncoder")
        .blocklist_function("NvEncCreateMVBuffer")
        .blocklist_function("NvEncDestroyMVBuffer")
        .blocklist_function("NvEncRunMotionEstimationOnly")
        .blocklist_function("NvEncGetLastErrorString")
        .blocklist_function("NvEncSetIOCudaStreams")
        .blocklist_function("NvEncRestoreEncoderState")
        .blocklist_function("NvEncLookaheadPicture")
        // Blocklist static-const GUID variables (internal linkage, not in
        // any shared library — we define them as Rust constants instead).
        .blocklist_var("NV_ENC_CODEC_H264_GUID")
        .blocklist_var("NV_ENC_CODEC_HEVC_GUID")
        .blocklist_var("NV_ENC_CODEC_AV1_GUID")
        .blocklist_var("NV_ENC_CODEC_PROFILE_AUTOSELECT_GUID")
        .blocklist_var("NV_ENC_H264_PROFILE_.*")
        .blocklist_var("NV_ENC_H264_PROFILE_STEREO_GUID")
        .blocklist_var("NV_ENC_H264_PROFILE_PROGRESSIVE_HIGH_GUID")
        .blocklist_var("NV_ENC_HEVC_PROFILE_.*")
        .blocklist_var("NV_ENC_AV1_PROFILE_.*")
        .blocklist_var("NV_ENC_PRESET_P._GUID")
        // Blocklist the version/struct macros — C #define macros can't be
        // translated by bindgen when they involve expressions. We define
        // them as Rust `const` in lib.rs.
        .blocklist_var("NVENCAPI_STRUCT_VERSION")
        .blocklist_var("NV_ENCODE_API_FUNCTION_LIST_VER")
        // Default enum style to Rust enum for nicer API.
        .default_enum_style(bindgen::EnumVariation::Rust {
            non_exhaustive: true,
        })
        // Bitfield enums: generate as constants.
        .bitfield_enum("_NV_ENC_PIC_FLAGS")
        .bitfield_enum("_NV_ENC_BUFFER_FORMAT")
        // Layout tests can be large; skip if desired.
        .layout_tests(false)
        .generate()
        .expect("Unable to generate NVENC bindings");

    let out_path = PathBuf::from(env::var("OUT_DIR").unwrap());
    bindings
        .write_to_file(out_path.join("bindings.rs"))
        .expect("Couldn't write bindings!");
}
