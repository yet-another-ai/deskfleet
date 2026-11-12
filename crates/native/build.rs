fn main() {
    println!("cargo:rerun-if-changed=src/speech/macos.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/speech/macos.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("deskfleet_speech");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=Speech");
    }
}
