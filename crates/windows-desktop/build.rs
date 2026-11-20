use std::collections::HashSet;
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;

const ENV_VAR: &str = "DESKFLEET_WINDOWS_SERVICE_PUBLIC_KEYS";

fn main() {
    println!("cargo:rerun-if-env-changed={ENV_VAR}");
    let raw = env::var(ENV_VAR).unwrap_or_default();
    let keys = parse_public_keys(&raw).unwrap_or_else(|message| {
        panic!("invalid {ENV_VAR}: {message}");
    });
    let mut output =
        String::from("pub(crate) const TRUSTED_PUBLIC_KEYS: &[(&str, [u8; 32])] = &[\n");
    for (id, bytes) in keys {
        let _ = writeln!(output, "    ({id:?}, {bytes:?}),");
    }
    output.push_str("];\n");
    let destination =
        PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR must be set")).join("trusted_keys.rs");
    fs::write(destination, output).expect("write trusted_keys.rs");
}

fn parse_public_keys(raw: &str) -> Result<Vec<(String, [u8; 32])>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let mut seen = HashSet::new();
    let mut keys = Vec::new();
    for entry in trimmed.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            return Err("empty entry in key list".into());
        }
        let Some((id, encoded)) = entry.split_once(':') else {
            return Err(format!("entry '{entry}' must have '<keyId>:<base64>' form"));
        };
        let id = id.trim();
        let encoded = encoded.trim();
        if id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err(format!("invalid key id '{id}'"));
        }
        if !seen.insert(id.to_owned()) {
            return Err(format!("duplicate key id '{id}'"));
        }
        let decoded = decode_base64(encoded).map_err(|reason| format!("key '{id}': {reason}"))?;
        let bytes: [u8; 32] = decoded.try_into().map_err(|actual: Vec<u8>| {
            format!(
                "key '{id}': expected 32 raw Ed25519 bytes, got {}",
                actual.len()
            )
        })?;
        keys.push((id.to_owned(), bytes));
    }
    Ok(keys)
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    if input.is_empty() || !input.len().is_multiple_of(4) {
        return Err("invalid base64 length".into());
    }
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len() / 4 * 3);
    for (chunk_index, chunk) in bytes.as_chunks::<4>().0.iter().enumerate() {
        let is_last = (chunk_index + 1) * 4 == bytes.len();
        let a = decode_sextet(chunk[0])?;
        let b = decode_sextet(chunk[1])?;
        output.push((a << 2) | (b >> 4));
        if chunk[2] == b'=' {
            if !is_last || chunk[3] != b'=' || (b & 0x0f) != 0 {
                return Err("invalid base64 padding".into());
            }
        } else {
            let c = decode_sextet(chunk[2])?;
            output.push((b << 4) | (c >> 2));
            if chunk[3] == b'=' {
                if !is_last || (c & 0x03) != 0 {
                    return Err("invalid base64 padding".into());
                }
            } else {
                let d = decode_sextet(chunk[3])?;
                output.push((c << 6) | d);
            }
        }
    }
    Ok(output)
}

fn decode_sextet(byte: u8) -> Result<u8, String> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err(format!("invalid base64 character '{}'", byte as char)),
    }
}
