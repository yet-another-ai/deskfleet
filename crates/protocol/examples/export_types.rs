fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("control.ts");
    let generated = deskfleet_protocol::control::typescript();
    if std::env::args().skip(1).any(|arg| arg == "--check") {
        if std::fs::read_to_string(path)? != generated {
            return Err(
                "generated control types are stale; run export_types without --check".into(),
            );
        }
    } else {
        std::fs::write(path, generated)?;
    }
    Ok(())
}
