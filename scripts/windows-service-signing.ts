import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

export const MANIFEST_FORMAT_VERSION = 1
export const MAX_SERVICE_BINARY_SIZE = 64 * 1024 * 1024
const SIGNING_DOMAIN = "deskfleet-windows-desktop-service-v1"
// RFC 8410 SubjectPublicKeyInfo prefix for a 32-byte raw Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const SEMVER_CORE = "(?:0|[1-9][0-9]*)"
const SEMVER_IDENT = `(?:${SEMVER_CORE}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`
const SEMVER_PATTERN = new RegExp(`^${SEMVER_CORE}\\.${SEMVER_CORE}\\.${SEMVER_CORE}(?:-${SEMVER_IDENT}(?:\\.${SEMVER_IDENT})*)?$`, "u")

export interface ServiceManifest {
  formatVersion: number
  version: string
  sha256: string
  size: number
  keyId: string
  signature: string
}

export interface GeneratedKeyPair {
  keyId: string
  privateKeyBase64: string
  publicKeyEntry: string
}

export function canonicalSigningMessage(version: string, sha256: string, size: number): string {
  return `${SIGNING_DOMAIN}\n${version}\n${sha256}\n${size}\n`
}

export function parsePrivateKey(encoded: string): KeyObject {
  const trimmed = encoded.trim()
  if (!trimmed) throw new Error("WINDOWS_SERVICE_SIGNING_KEY is empty")
  if (trimmed.startsWith("-----BEGIN")) {
    return createPrivateKey({ key: trimmed, format: "pem" })
  }
  const decoded = Buffer.from(trimmed, "base64")
  if (decoded.toString("utf8").includes("-----BEGIN")) {
    return createPrivateKey({ key: decoded, format: "pem" })
  }
  return createPrivateKey({ key: decoded, format: "der", type: "pkcs8" })
}

export function rawPublicKeyFromKeyObject(key: KeyObject): Buffer {
  const pub = key.type === "public" ? key : createPublicKey(key)
  const spki = pub.export({ format: "der", type: "spki" }) as Buffer
  if (spki.length !== ED25519_SPKI_PREFIX.length + 32 || !spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new Error("Expected an Ed25519 key")
  }
  return spki.subarray(ED25519_SPKI_PREFIX.length)
}

export function parsePublicKeys(raw: string): Map<string, KeyObject> {
  const result = new Map<string, KeyObject>()
  const trimmed = raw.trim()
  if (!trimmed) return result
  for (const entry of trimmed.split(",")) {
    const item = entry.trim()
    const separator = item.indexOf(":")
    if (separator <= 0) throw new Error(`Invalid public key entry '${item}'; expected '<keyId>:<base64>'`)
    const keyId = item.slice(0, separator).trim()
    const encoded = item.slice(separator + 1).trim()
    if (!KEY_ID_PATTERN.test(keyId)) throw new Error(`Invalid key id '${keyId}'`)
    if (result.has(keyId)) throw new Error(`Duplicate key id '${keyId}'`)
    const bytes = Buffer.from(encoded, "base64")
    if (bytes.length !== 32 || bytes.toString("base64") !== encoded) {
      throw new Error(`Public key '${keyId}' must be base64-encoded 32 raw Ed25519 bytes`)
    }
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, bytes])
    result.set(keyId, createPublicKey({ key: spki, format: "der", type: "spki" }))
  }
  return result
}

export function generateSigningKeyPair(keyId = "v1"): GeneratedKeyPair {
  if (!KEY_ID_PATTERN.test(keyId)) throw new Error(`Invalid key id '${keyId}'`)
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer
  const rawPub = rawPublicKeyFromKeyObject(publicKey)
  return {
    keyId,
    privateKeyBase64: pkcs8.toString("base64"),
    publicKeyEntry: `${keyId}:${rawPub.toString("base64")}`,
  }
}

export function signServiceBytes(
  bytes: Buffer,
  version: string,
  privateKeyInput: string,
  keyId = "v1",
): ServiceManifest {
  if (!SEMVER_PATTERN.test(version)) throw new Error(`Invalid release version '${version}'`)
  if (!KEY_ID_PATTERN.test(keyId)) throw new Error(`Invalid key id '${keyId}'`)
  if (bytes.length === 0 || bytes.length > MAX_SERVICE_BINARY_SIZE) {
    throw new Error(`Desktop service binary size ${bytes.length} is out of bounds`)
  }
  const privateKey = parsePrivateKey(privateKeyInput)
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`Expected an Ed25519 private key, got ${privateKey.asymmetricKeyType ?? "unknown"}`)
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const message = canonicalSigningMessage(version, sha256, bytes.length)
  const signature = sign(null, Buffer.from(message, "utf8"), privateKey)
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    version,
    sha256,
    size: bytes.length,
    keyId,
    signature: signature.toString("base64"),
  }
}

export function verifyServiceBytes(
  bytes: Buffer,
  manifest: ServiceManifest,
  publicKeysRaw: string,
): void {
  if (manifest.formatVersion !== MANIFEST_FORMAT_VERSION) {
    throw new Error(`Unsupported manifest format version: ${manifest.formatVersion}`)
  }
  if (!SEMVER_PATTERN.test(manifest.version)) {
    throw new Error(`Invalid manifest version: ${manifest.version}`)
  }
  if (!SHA256_PATTERN.test(manifest.sha256)) {
    throw new Error("Invalid manifest sha256")
  }
  if (bytes.length !== manifest.size) {
    throw new Error(`Binary size mismatch: expected ${manifest.size}, got ${bytes.length}`)
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex")
  if (actualSha256 !== manifest.sha256) {
    throw new Error("Binary SHA-256 mismatch")
  }
  const keys = parsePublicKeys(publicKeysRaw)
  const publicKey = keys.get(manifest.keyId)
  if (!publicKey) {
    throw new Error(`Manifest keyId '${manifest.keyId}' is not present in trusted public keys`)
  }
  const signature = Buffer.from(manifest.signature, "base64")
  if (signature.length !== 64) {
    throw new Error("Manifest signature must be 64 bytes")
  }
  const message = canonicalSigningMessage(manifest.version, manifest.sha256, manifest.size)
  if (!verify(null, Buffer.from(message, "utf8"), publicKey, signature)) {
    throw new Error("Ed25519 signature verification failed")
  }
}

export function signServiceFile(
  exePath: string,
  version: string,
  outputManifestPath: string,
  privateKeyInput: string,
  keyId = "v1",
  trustedPublicKeysRaw?: string,
): ServiceManifest {
  const bytes = readFileSync(exePath)
  const manifest = signServiceBytes(bytes, version, privateKeyInput, keyId)
  const derivedPublic = `${keyId}:${rawPublicKeyFromKeyObject(parsePrivateKey(privateKeyInput)).toString("base64")}`
  verifyServiceBytes(bytes, manifest, trustedPublicKeysRaw?.trim() ? trustedPublicKeysRaw : derivedPublic)
  writeFileSync(outputManifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8")
  return manifest
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === "keygen") {
    const generated = generateSigningKeyPair(rest[0] ?? "v1")
    console.log(`DESKFLEET_WINDOWS_SERVICE_PUBLIC_KEYS=${generated.publicKeyEntry}`)
    console.log(`WINDOWS_SERVICE_SIGNING_KEY_ID=${generated.keyId}`)
    console.log(`WINDOWS_SERVICE_SIGNING_KEY=${generated.privateKeyBase64}`)
  } else if (command === "sign") {
    const [exePath, version, outputManifestPath] = rest
    if (!exePath || !version || !outputManifestPath) {
      throw new Error("Usage: node scripts/windows-service-signing.ts sign <exePath> <version> <outputManifestPath>")
    }
    const privateKey = process.env.WINDOWS_SERVICE_SIGNING_KEY ?? ""
    const keyId = process.env.WINDOWS_SERVICE_SIGNING_KEY_ID?.trim() || "v1"
    const manifest = signServiceFile(
      resolve(exePath),
      version,
      resolve(outputManifestPath),
      privateKey,
      keyId,
      process.env.DESKFLEET_WINDOWS_SERVICE_PUBLIC_KEYS,
    )
    console.log(`Signed ${exePath} (${manifest.version}, keyId=${manifest.keyId}) -> ${outputManifestPath}`)
  } else if (command === "verify") {
    const [exePath, manifestPath] = rest
    if (!exePath || !manifestPath) {
      throw new Error("Usage: node scripts/windows-service-signing.ts verify <exePath> <manifestPath>")
    }
    const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8")) as ServiceManifest
    verifyServiceBytes(readFileSync(resolve(exePath)), manifest, process.env.DESKFLEET_WINDOWS_SERVICE_PUBLIC_KEYS ?? "")
    console.log(`Verified ${exePath} (${manifest.version}, keyId=${manifest.keyId})`)
  } else {
    throw new Error("Expected subcommand: keygen, sign, or verify")
  }
}
