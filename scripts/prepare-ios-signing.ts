import { execFileSync } from "node:child_process"
import { X509Certificate } from "node:crypto"
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { AppStoreConnect, requiredEnv } from "./app-store-connect.ts"

const appGroup = "group.ai.yetanother.deskfleet"
const targets = [
  { bundleId: "ai.yetanother.deskfleet", variable: "IOS_APP_PROFILE_NAME", output: "DESKFLEET_IOS_APP_PROFILE_UUID" },
  { bundleId: "ai.yetanother.deskfleet.BroadcastUpload", variable: "IOS_BROADCAST_PROFILE_NAME", output: "DESKFLEET_IOS_BROADCAST_PROFILE_UUID" },
] as const

export interface ProfileResource {
  id: string
  attributes: {
    name: string
    profileType: string
    profileState: string
    profileContent: string
  }
}

export interface SigningProfile {
  name: string
  uuid: string
  teamIdentifiers: string[]
  applicationIdentifierPrefixes: string[]
  expirationDate: string
  certificateSHA1: string
  entitlements: Record<string, unknown>
  provisionedDevices: boolean
  provisionsAllDevices: boolean
}

export function selectProfile(resources: ProfileResource[], name: string): ProfileResource {
  const matches = resources.filter(profile => profile.attributes.name === name && profile.attributes.profileType === "IOS_APP_STORE")
  if (matches.length !== 1) throw new Error(`Expected one App Store profile named ${name}; found ${matches.length}. An administrator must create a profile bound to the existing Distribution certificate.`)
  const profile = matches[0]!
  if (profile.attributes.profileState !== "ACTIVE") throw new Error(`Profile ${name} is ${profile.attributes.profileState}; an administrator must update it.`)
  return profile
}

export function validateProfile(profile: SigningProfile, bundleId: string, teamId: string, identities: Set<string>, now = Date.now()): void {
  const fail = (message: string): never => { throw new Error(`Profile ${profile.name}: ${message}`) }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(profile.uuid)) fail("invalid UUID")
  if (!profile.teamIdentifiers.includes(teamId)) fail(`does not belong to team ${teamId}`)
  if (!(Date.parse(profile.expirationDate) > now)) fail("has expired or has an invalid expiration date")
  if (!identities.has(profile.certificateSHA1)) fail("does not contain an available Apple Distribution certificate and private key from IOS_DIST_CERT_P12")
  if (!profile.applicationIdentifierPrefixes.some(prefix => profile.entitlements["application-identifier"] === `${prefix}.${bundleId}`)) fail(`does not authorize ${bundleId}`)
  const groups = profile.entitlements["com.apple.security.application-groups"]
  if (!Array.isArray(groups) || !groups.includes(appGroup)) fail(`does not include App Group ${appGroup}`)
  if (profile.entitlements["get-task-allow"] !== false || profile.provisionedDevices || profile.provisionsAllDevices) fail("is not an App Store distribution profile")
}

function command(executable: string, args: string[], input?: string): string {
  return execFileSync(executable, args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim()
}

function distributionIdentities(keychain: string, teamId: string): Set<string> {
  const identities = command("security", ["find-identity", "-v", "-p", "codesigning", keychain])
  const available = new Set([...identities.matchAll(/\b([0-9A-F]{40})\s+"/gu)].map(match => match[1]!))
  const certificates = command("security", ["find-certificate", "-a", "-p", keychain])
  const valid = new Set<string>()
  for (const pem of certificates.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu)) {
    const cert = new X509Certificate(pem[0])
    const fingerprint = cert.fingerprint.replaceAll(":", "")
    if (available.has(fingerprint) && cert.subject.split("\n").includes(`OU=${teamId}`)
      && cert.subject.split("\n").some(field => field.startsWith("CN=Apple Distribution:"))
      && Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now()) valid.add(fingerprint)
  }
  if (!valid.size) throw new Error(`IOS_DIST_CERT_P12 must contain a valid Apple Distribution certificate and matching private key for team ${teamId}`)
  return valid
}

export function decodeProfile(path: string): SigningProfile {
  const plist = command("security", ["cms", "-D", "-i", path])
  const extract = (key: string, format = "raw") => command("plutil", ["-extract", key, format, "-o", "-", "--", "-"], plist)
  const has = (key: string): boolean => {
    try { extract(key, "xml1"); return true }
    catch { return false }
  }
  return {
    name: extract("Name"), uuid: extract("UUID"),
    teamIdentifiers: JSON.parse(extract("TeamIdentifier", "json")),
    applicationIdentifierPrefixes: JSON.parse(extract("ApplicationIdentifierPrefix", "json")),
    expirationDate: extract("ExpirationDate"),
    certificateSHA1: new X509Certificate(Buffer.from(extract("DeveloperCertificates.0"), "base64")).fingerprint.replaceAll(":", ""),
    entitlements: JSON.parse(extract("Entitlements", "json")),
    provisionedDevices: has("ProvisionedDevices"),
    provisionsAllDevices: has("ProvisionsAllDevices") && extract("ProvisionsAllDevices") === "true",
  }
}

export async function prepareSigning(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const teamId = requiredEnv(env, "APPLE_TEAM_ID")
  const keychain = requiredEnv(env, "IOS_SIGNING_KEYCHAIN")
  const names = targets.map(target => requiredEnv(env, target.variable))
  const identities = distributionIdentities(keychain, teamId)
  const api = new AppStoreConnect(env)
  const resources = await Promise.all(names.map(async name => selectProfile(await api.list<ProfileResource>(`/v1/profiles?${new URLSearchParams({ "filter[name]": name })}`), name)))
  const temporary = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "deskfleet-ios-profiles-"))
  const installed: string[] = []
  try {
    const profiles = resources.map((resource, index) => {
      const path = join(temporary, `${index}.mobileprovision`)
      writeFileSync(path, Buffer.from(resource.attributes.profileContent, "base64"), { mode: 0o600 })
      const profile = decodeProfile(path)
      validateProfile(profile, targets[index]!.bundleId, teamId, identities)
      return { profile, path }
    })
    const certificate = profiles[0]!.profile.certificateSHA1
    if (profiles.some(({ profile }) => profile.certificateSHA1 !== certificate)) throw new Error("App and BroadcastUpload profiles must use the same Distribution certificate")
    const destination = join(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles")
    mkdirSync(destination, { recursive: true })
    for (const { profile, path } of profiles) {
      const installedPath = join(destination, `${profile.uuid}.mobileprovision`)
      if (!existsSync(installedPath)) {
        copyFileSync(path, installedPath)
        installed.push(installedPath)
      }
      console.log(`Validated App Store profile ${profile.name}, expires ${profile.expirationDate}`)
    }
    const values = [
      `DESKFLEET_IOS_SIGNING_IDENTITY=${certificate}`,
      ...profiles.map(({ profile }, index) => `${targets[index]!.output}=${profile.uuid}`),
    ]
    if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `${values.join("\n")}\n`)
    else console.log(values.map(value => `export ${value}`).join("\n"))
  } catch (error) {
    for (const path of installed) rmSync(path, { force: true })
    throw error
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) await prepareSigning()
