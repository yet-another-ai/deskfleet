import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { X509Certificate } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { decodeProfile, selectProfile, validateProfile, type ProfileResource, type SigningProfile } from "./prepare-ios-signing.ts"

const team = "TEAM123456"
const bundle = "ai.yetanother.deskfleet"
const fingerprint = "A".repeat(40)
const now = Date.parse("2026-01-01T00:00:00Z")
function profile(): SigningProfile {
  return {
    name: "DeskFleet App Store", uuid: "00000000-0000-0000-0000-000000000001",
    teamIdentifiers: [team], applicationIdentifierPrefixes: ["LEGACYPREF"],
    expirationDate: "2027-01-01T00:00:00Z", certificateSHA1: fingerprint,
    entitlements: { "application-identifier": `LEGACYPREF.${bundle}`, "get-task-allow": false, "com.apple.security.application-groups": ["group.ai.yetanother.deskfleet"] },
    provisionedDevices: false, provisionsAllDevices: false,
  }
}

test("a matching App Store profile accepts an existing identity and a legacy App ID prefix", () => {
  assert.doesNotThrow(() => validateProfile(profile(), bundle, team, new Set([fingerprint]), now))
})

test("an App Store profile need not explicitly deny the debugging entitlement", () => {
  const value = profile()
  delete value.entitlements["get-task-allow"]
  assert.doesNotThrow(() => validateProfile(value, bundle, team, new Set([fingerprint]), now))
})

test("signing preflight rejects the actual mismatches before building", () => {
  const cases: [string, (value: SigningProfile) => void, RegExp][] = [
    ["wrong team", value => { value.teamIdentifiers = ["OTHERTEAM"] }, /does not belong/],
    ["expired profile", value => { value.expirationDate = "2025-01-01T00:00:00Z" }, /expired/],
    ["cloud certificate instead of the imported p12", value => { value.certificateSHA1 = "B".repeat(40) }, /private key/],
    ["app and extension profiles swapped", value => { value.entitlements["application-identifier"] += ".BroadcastUpload" }, /does not authorize/],
    ["missing App Group", value => { value.entitlements["com.apple.security.application-groups"] = [] }, /App Group/],
    ["development", value => { value.entitlements["get-task-allow"] = true }, /App Store distribution/],
    ["ad hoc", value => { value.provisionedDevices = true }, /App Store distribution/],
    ["enterprise", value => { value.provisionsAllDevices = true }, /App Store distribution/],
    ["invalid UUID", value => { value.uuid = "../../unexpected" }, /invalid UUID/],
  ]
  for (const [name, mutate, error] of cases) {
    const value = profile()
    mutate(value)
    assert.throws(() => validateProfile(value, bundle, team, new Set([fingerprint]), now), error, name)
  }
})

test("profile selection requires one existing active App Store profile", () => {
  const resource: ProfileResource = { id: "profile", attributes: { name: "release", profileType: "IOS_APP_STORE", profileState: "ACTIVE", profileContent: "" } }
  assert.equal(selectProfile([resource], "release"), resource)
  assert.throws(() => selectProfile([], "release"), /administrator must create/)
  assert.throws(() => selectProfile([resource, resource], "release"), /found 2/)
  assert.throws(() => selectProfile([{ ...resource, attributes: { ...resource.attributes, profileState: "INVALID" } }], "release"), /administrator must update/)
  assert.throws(() => selectProfile([{ ...resource, attributes: { ...resource.attributes, profileType: "IOS_APP_DEVELOPMENT" } }], "release"), /found 0/)
})

test("macOS decodes CMS profile certificates, dates, and App Group entitlements", { skip: process.platform !== "darwin" }, context => {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-profile-test-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const key = join(directory, "fixture.key")
  const certificate = join(directory, "fixture.pem")
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate, "-days", "1", "-subj", `/CN=Apple Distribution: Fixture/OU=${team}`], { stdio: "pipe" })
  const cert = new X509Certificate(readFileSync(certificate))
  const plist = join(directory, "profile.plist")
  const cms = join(directory, "profile.mobileprovision")
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Name</key><string>Fixture</string><key>UUID</key><string>${profile().uuid}</string>
<key>TeamIdentifier</key><array><string>${team}</string></array>
<key>ApplicationIdentifierPrefix</key><array><string>${team}</string></array>
<key>ExpirationDate</key><date>2027-01-01T00:00:00Z</date>
<key>DeveloperCertificates</key><array><data>${cert.raw.toString("base64")}</data></array>
<key>Entitlements</key><dict><key>application-identifier</key><string>${team}.${bundle}</string>
<key>get-task-allow</key><false/><key>com.apple.security.application-groups</key><array><string>group.ai.yetanother.deskfleet</string></array></dict>
</dict></plist>`)
  execFileSync("openssl", ["smime", "-sign", "-in", plist, "-out", cms, "-signer", certificate, "-inkey", key, "-outform", "DER", "-nodetach"], { stdio: "pipe" })
  const decoded = decodeProfile(cms)
  const identity = cert.fingerprint.replaceAll(":", "")
  assert.equal(decoded.certificateSHA1, identity)
  assert.doesNotThrow(() => validateProfile(decoded, bundle, team, new Set([identity]), now))
})
