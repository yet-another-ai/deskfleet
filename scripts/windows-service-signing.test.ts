import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  generateSigningKeyPair,
  parsePublicKeys,
  signServiceBytes,
  signServiceFile,
  verifyServiceBytes,
  type ServiceManifest,
} from "./windows-service-signing.ts"

test("generated Ed25519 key pair signs and verifies desktop service bytes", () => {
  const first = generateSigningKeyPair("v1")
  const second = generateSigningKeyPair("v2")
  const payload = Buffer.from("MZ-fake-desktop-service-binary")
  const manifest = signServiceBytes(payload, "0.20.0", second.privateKeyBase64, second.keyId)
  assert.equal(manifest.formatVersion, 1)
  assert.equal(manifest.version, "0.20.0")
  assert.equal(manifest.size, payload.length)
  assert.equal(manifest.keyId, "v2")
  const keyList = `${first.publicKeyEntry},${second.publicKeyEntry}`
  assert.equal(parsePublicKeys(keyList).size, 2)
  verifyServiceBytes(payload, manifest, keyList)
})

test("verification rejects tampered payloads, wrong keys, and malformed inputs", () => {
  const trusted = generateSigningKeyPair("v1")
  const untrusted = generateSigningKeyPair("v1")
  const payload = Buffer.from("authentic-binary")
  const manifest = signServiceBytes(payload, "0.20.0-rc.1", trusted.privateKeyBase64, "v1")

  assert.throws(() => verifyServiceBytes(Buffer.from("tampered-binary!"), manifest, trusted.publicKeyEntry), /SHA-256 mismatch/)
  assert.throws(() => verifyServiceBytes(Buffer.from("short"), manifest, trusted.publicKeyEntry), /size mismatch/)
  assert.throws(() => verifyServiceBytes(payload, manifest, untrusted.publicKeyEntry), /verification failed/)
  assert.throws(() => verifyServiceBytes(payload, manifest, ""), /not present in trusted public keys/)
  assert.throws(() => signServiceBytes(payload, "0.20.0+build", trusted.privateKeyBase64, "v1"), /Invalid release version/)
})

test("signServiceFile writes verified manifest and rejects mismatched public keys", context => {
  const dir = mkdtempSync(join(tmpdir(), "deskfleet-service-sign-"))
  context.after(() => rmSync(dir, { recursive: true, force: true }))
  const exe = join(dir, "deskfleet-desktop-service.exe")
  const manifestPath = join(dir, "deskfleet-desktop-service.manifest.json")
  writeFileSync(exe, "binary-contents")
  const pair = generateSigningKeyPair("prod-1")
  const other = generateSigningKeyPair("prod-1")

  signServiceFile(exe, "0.20.0", manifestPath, pair.privateKeyBase64, "prod-1", pair.publicKeyEntry)
  const written = JSON.parse(readFileSync(manifestPath, "utf8")) as ServiceManifest
  verifyServiceBytes(readFileSync(exe), written, pair.publicKeyEntry)

  assert.throws(
    () => signServiceFile(exe, "0.20.0", manifestPath, pair.privateKeyBase64, "prod-1", other.publicKeyEntry),
    /verification failed/,
  )
})
