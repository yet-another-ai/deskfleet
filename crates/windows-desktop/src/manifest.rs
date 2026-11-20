//! Cryptographic verification and anti-downgrade rules for signed desktop service updates.

use std::cmp::Ordering;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::str::FromStr;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest as _, Sha256};

include!(concat!(env!("OUT_DIR"), "/trusted_keys.rs"));

/// Maximum accepted `deskfleet-desktop-service.exe` payload size (64 MiB).
pub const MAX_SERVICE_BINARY_SIZE: u64 = 64 * 1024 * 1024;
/// Current signed manifest schema version.
pub const MANIFEST_FORMAT_VERSION: u32 = 1;
const SIGNING_DOMAIN: &str = "deskfleet-windows-desktop-service-v1";

/// Signed metadata accompanying a packaged `deskfleet-desktop-service.exe`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceManifest {
    pub format_version: u32,
    pub version: String,
    pub sha256: String,
    pub size: u64,
    pub key_id: String,
    pub signature: String,
}

/// Protected installation record stored beside the installed service binary.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledRecord {
    pub version: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PrereleasePart {
    Numeric(u64),
    AlphaNumeric(String),
}

impl Ord for PrereleasePart {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Numeric(left), Self::Numeric(right)) => left.cmp(right),
            (Self::Numeric(_), Self::AlphaNumeric(_)) => Ordering::Less,
            (Self::AlphaNumeric(_), Self::Numeric(_)) => Ordering::Greater,
            (Self::AlphaNumeric(left), Self::AlphaNumeric(right)) => left.cmp(right),
        }
    }
}

impl PartialOrd for PrereleasePart {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Strict SemVer matching DeskFleet release tags (`MAJOR.MINOR.PATCH[-prerelease]`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemVer {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Vec<PrereleasePart>,
}

impl FromStr for SemVer {
    type Err = io::Error;

    fn from_str(input: &str) -> Result<Self, Self::Err> {
        if input.contains('+') {
            return Err(invalid("release version must not include build metadata"));
        }
        let (core, prerelease) = match input.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (input, None),
        };
        let mut parts = core.split('.');
        let major = parse_numeric_identifier(parts.next())?;
        let minor = parse_numeric_identifier(parts.next())?;
        let patch = parse_numeric_identifier(parts.next())?;
        if parts.next().is_some() {
            return Err(invalid("release version must have MAJOR.MINOR.PATCH"));
        }
        let mut pre_parts = Vec::new();
        if let Some(pre) = prerelease {
            if pre.is_empty() {
                return Err(invalid("release version prerelease cannot be empty"));
            }
            for segment in pre.split('.') {
                if segment.is_empty()
                    || !segment
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                {
                    return Err(invalid("invalid prerelease identifier in release version"));
                }
                if segment.bytes().all(|byte| byte.is_ascii_digit()) {
                    pre_parts.push(PrereleasePart::Numeric(parse_numeric_identifier(Some(
                        segment,
                    ))?));
                } else {
                    pre_parts.push(PrereleasePart::AlphaNumeric(segment.to_owned()));
                }
            }
        }
        Ok(Self {
            major,
            minor,
            patch,
            prerelease: pre_parts,
        })
    }
}

impl Ord for SemVer {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(
                || match (self.prerelease.is_empty(), other.prerelease.is_empty()) {
                    (true, true) => Ordering::Equal,
                    (true, false) => Ordering::Greater,
                    (false, true) => Ordering::Less,
                    (false, false) => self.prerelease.cmp(&other.prerelease),
                },
            )
    }
}

impl PartialOrd for SemVer {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn parse_numeric_identifier(segment: Option<&str>) -> io::Result<u64> {
    let segment = segment.ok_or_else(|| invalid("missing numeric version segment"))?;
    if segment.is_empty()
        || !segment.bytes().all(|byte| byte.is_ascii_digit())
        || (segment.len() > 1 && segment.starts_with('0'))
    {
        return Err(invalid("invalid numeric version segment"));
    }
    segment
        .parse::<u64>()
        .map_err(|_| invalid("numeric version segment overflow"))
}

/// Returns the canonical UTF-8 payload signed by the release Ed25519 key.
#[must_use]
pub fn canonical_signing_message(version: &str, sha256: &str, size: u64) -> String {
    format!("{SIGNING_DOMAIN}\n{version}\n{sha256}\n{size}\n")
}

/// Returns the compile-time trusted Ed25519 public keys.
#[must_use]
pub fn trusted_public_keys() -> &'static [(&'static str, [u8; 32])] {
    TRUSTED_PUBLIC_KEYS
}

/// Validates a hex-encoded SHA-256 digest (64 lowercase ASCII hex digits).
#[must_use]
pub fn is_valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Encodes a SHA-256 digest as lowercase hexadecimal.
#[must_use]
pub fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

/// Computes the lowercase SHA-256 digest and byte length of a file on disk.
///
/// # Errors
/// Returns filesystem read errors or an error if the file exceeds
/// [`MAX_SERVICE_BINARY_SIZE`].
pub fn sha256_file(path: &Path) -> io::Result<(String, u64)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| invalid("service binary size overflow"))?;
        if total > MAX_SERVICE_BINARY_SIZE {
            return Err(invalid("service binary exceeds maximum allowed size"));
        }
        hasher.update(&buffer[..count]);
    }
    Ok((encode_hex(&hasher.finalize()), total))
}

/// Verifies a signed service manifest against the actual binary hash, size, and
/// trusted Ed25519 public keys.
///
/// # Errors
/// Returns an `InvalidData` or `PermissionDenied` error when the manifest is
/// malformed, unsigned, tampered with, or signed by an untrusted key.
pub fn verify_manifest(
    manifest: &ServiceManifest,
    actual_sha256: &str,
    actual_size: u64,
    trusted_keys: &[(&str, [u8; 32])],
) -> io::Result<SemVer> {
    if manifest.format_version != MANIFEST_FORMAT_VERSION {
        return Err(invalid("unsupported desktop service manifest format"));
    }
    if actual_size == 0 || actual_size > MAX_SERVICE_BINARY_SIZE {
        return Err(invalid("desktop service binary size is out of bounds"));
    }
    if manifest.size != actual_size {
        return Err(denied(
            "desktop service binary size does not match manifest",
        ));
    }
    if !is_valid_sha256(&manifest.sha256) || !is_valid_sha256(actual_sha256) {
        return Err(invalid("invalid desktop service sha256 digest"));
    }
    if manifest.sha256 != actual_sha256 {
        return Err(denied(
            "desktop service binary digest does not match manifest",
        ));
    }
    let version = SemVer::from_str(&manifest.version)?;
    if trusted_keys.is_empty() {
        return Err(denied(
            "no trusted signing keys are configured in this build",
        ));
    }
    let (_, key_bytes) = trusted_keys
        .iter()
        .find(|(id, _)| *id == manifest.key_id)
        .ok_or_else(|| denied("desktop service manifest uses an untrusted signing key"))?;
    let verifying_key = VerifyingKey::from_bytes(key_bytes)
        .map_err(|_| denied("trusted desktop service signing key is invalid"))?;
    let signature_bytes = STANDARD
        .decode(&manifest.signature)
        .map_err(|_| invalid("desktop service manifest signature is not valid base64"))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| invalid("desktop service manifest signature must be 64 bytes"))?;
    let message = canonical_signing_message(&manifest.version, &manifest.sha256, manifest.size);
    verifying_key
        .verify_strict(message.as_bytes(), &signature)
        .map_err(|_| denied("desktop service manifest signature verification failed"))?;
    Ok(version)
}

/// Enforces monotonic release versions to prevent downgrade and same-version
/// binary substitution attacks.
///
/// Returns `Ok(true)` when the binary should be replaced and `Ok(false)` when
/// the exact verified digest is already installed at or above `floor`.
///
/// # Errors
/// Returns `PermissionDenied` if `candidate` is older than `floor`, or equal
/// to `floor` with a different binary digest.
pub fn check_version_floor(
    candidate: &SemVer,
    candidate_sha256: &str,
    floor: &SemVer,
    installed_sha256: Option<&str>,
) -> io::Result<bool> {
    if installed_sha256 == Some(candidate_sha256) {
        if candidate < floor {
            return Err(denied("desktop service version cannot downgrade"));
        }
        return Ok(false);
    }
    if candidate <= floor {
        return Err(denied(
            "desktop service update version must be newer than the installed version",
        ));
    }
    Ok(true)
}

/// Returns `true` when `desktop-service.installed.json` is missing, unreadable,
/// has a different digest, or records an older version than the verified
/// installed binary so retries always lock in the latest anti-downgrade floor.
#[must_use]
pub fn should_update_installed_record(
    existing: Option<&InstalledRecord>,
    candidate: &SemVer,
    candidate_sha256: &str,
) -> bool {
    let Some(record) = existing else {
        return true;
    };
    if record.sha256 != candidate_sha256 {
        return true;
    }
    SemVer::from_str(&record.version).map_or(true, |recorded| recorded < *candidate)
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn denied(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer as _, SigningKey};

    fn signed_manifest(
        signing_key: &SigningKey,
        key_id: &str,
        version: &str,
        payload: &[u8],
    ) -> (ServiceManifest, String, u64) {
        let digest = encode_hex(&Sha256::digest(payload));
        let size = payload.len() as u64;
        let message = canonical_signing_message(version, &digest, size);
        let signature = signing_key.sign(message.as_bytes());
        (
            ServiceManifest {
                format_version: MANIFEST_FORMAT_VERSION,
                version: version.to_owned(),
                sha256: digest.clone(),
                size,
                key_id: key_id.to_owned(),
                signature: STANDARD.encode(signature.to_bytes()),
            },
            digest,
            size,
        )
    }

    #[test]
    fn valid_ed25519_manifest_verifies_and_supports_key_rotation() {
        let old_key = SigningKey::from_bytes(&[1u8; 32]);
        let new_key = SigningKey::from_bytes(&[2u8; 32]);
        let trusted = [
            ("v1", old_key.verifying_key().to_bytes()),
            ("v2", new_key.verifying_key().to_bytes()),
        ];
        let (manifest, digest, size) = signed_manifest(&new_key, "v2", "0.20.0", b"binary-bytes");
        let parsed = verify_manifest(&manifest, &digest, size, &trusted).unwrap();
        assert_eq!(parsed, SemVer::from_str("0.20.0").unwrap());
    }

    #[test]
    fn tampered_payload_wrong_key_or_missing_keys_are_rejected() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let other = SigningKey::from_bytes(&[8u8; 32]);
        let trusted = [("v1", key.verifying_key().to_bytes())];
        let (mut manifest, digest, size) = signed_manifest(&key, "v1", "0.20.0", b"original");

        // No trusted keys configured.
        assert_eq!(
            verify_manifest(&manifest, &digest, size, &[])
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );

        // Tampered binary digest.
        let tampered_digest = encode_hex(&Sha256::digest(b"tampered"));
        assert_eq!(
            verify_manifest(&manifest, &tampered_digest, size, &trusted)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );

        // Tampered size.
        assert_eq!(
            verify_manifest(&manifest, &digest, size + 1, &trusted)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );

        // Wrong signing key.
        let (other_manifest, _, _) = signed_manifest(&other, "v1", "0.20.0", b"original");
        assert_eq!(
            verify_manifest(&other_manifest, &digest, size, &trusted)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );

        // Unknown key id.
        manifest.key_id = "unknown".to_owned();
        assert_eq!(
            verify_manifest(&manifest, &digest, size, &trusted)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn semver_ordering_and_downgrade_floor_are_strictly_enforced() {
        let v_pre_1 = SemVer::from_str("0.20.0-rc.1").unwrap();
        let v_pre_2 = SemVer::from_str("0.20.0-rc.2").unwrap();
        let v_pre_10 = SemVer::from_str("0.20.0-rc.10").unwrap();
        let v_release = SemVer::from_str("0.20.0").unwrap();
        let v_next = SemVer::from_str("0.20.1").unwrap();
        assert!(v_pre_1 < v_pre_2);
        assert!(v_pre_2 < v_pre_10);
        assert!(v_pre_10 < v_release);
        assert!(v_release < v_next);

        let old_hash = "a".repeat(64);
        let new_hash = "b".repeat(64);

        // Newer version with new hash -> replace.
        assert!(check_version_floor(&v_next, &new_hash, &v_release, Some(&old_hash)).unwrap());

        // Same version with identical hash -> no-op.
        assert!(!check_version_floor(&v_release, &old_hash, &v_release, Some(&old_hash)).unwrap());

        // Same version with DIFFERENT hash -> rejected (no same-version substitution).
        assert_eq!(
            check_version_floor(&v_release, &new_hash, &v_release, Some(&old_hash))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );

        // Older version -> rejected (anti-downgrade).
        assert_eq!(
            check_version_floor(&v_pre_10, &new_hash, &v_release, Some(&old_hash))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn installed_record_is_healed_when_missing_mismatched_or_behind_verified_version() {
        let v_old = SemVer::from_str("0.20.0").unwrap();
        let v_new = SemVer::from_str("0.21.0").unwrap();
        let old_hash = "a".repeat(64);
        let new_hash = "b".repeat(64);

        assert!(should_update_installed_record(None, &v_new, &new_hash));
        assert!(should_update_installed_record(
            Some(&InstalledRecord {
                version: "0.20.0".to_owned(),
                sha256: old_hash.clone(),
            }),
            &v_new,
            &new_hash,
        ));
        assert!(should_update_installed_record(
            Some(&InstalledRecord {
                version: "0.20.0".to_owned(),
                sha256: new_hash.clone(),
            }),
            &v_new,
            &new_hash,
        ));
        assert!(should_update_installed_record(
            Some(&InstalledRecord {
                version: "not-semver".to_owned(),
                sha256: new_hash.clone(),
            }),
            &v_new,
            &new_hash,
        ));
        assert!(!should_update_installed_record(
            Some(&InstalledRecord {
                version: "0.21.0".to_owned(),
                sha256: new_hash.clone(),
            }),
            &v_new,
            &new_hash,
        ));
        assert!(!should_update_installed_record(
            Some(&InstalledRecord {
                version: "0.21.0".to_owned(),
                sha256: new_hash.clone(),
            }),
            &v_old,
            &new_hash,
        ));
    }

    #[test]
    fn rejects_malformed_semver_strings() {
        for bad in [
            "",
            "0.20",
            "01.0.0",
            "0.20.0+build1",
            "0.20.0-",
            "0.20.0-rc.01",
            "0.20.0-rc..1",
        ] {
            assert!(SemVer::from_str(bad).is_err(), "should reject {bad:?}");
        }
    }
}
