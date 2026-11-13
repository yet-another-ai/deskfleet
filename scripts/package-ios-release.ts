import { spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { join, resolve } from "node:path"
import { readReleaseVersions } from "./release-version.ts"

export interface IosRelease {
  bundleId: "ai.yetanother.deskfleet"
  version: string
  buildNumber: string
  ipa: "App.ipa"
}

interface IosSigning {
  teamId: string
  identity: string
  appProfile: string
  broadcastProfile: string
}

export function iosRelease(version: string, env: NodeJS.ProcessEnv): IosRelease {
  const core = version.split("-", 1)[0]!
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(core)) {
    throw new Error("iOS marketing version must be MAJOR.MINOR.PATCH")
  }
  let buildNumber = env.IOS_BUILD_NUMBER?.trim()
  if (!buildNumber) {
    if (env.GITHUB_RUN_NUMBER || env.GITHUB_RUN_ATTEMPT) {
      if (!/^[1-9]\d*$/u.test(env.GITHUB_RUN_NUMBER ?? "") || !/^[1-9]\d*$/u.test(env.GITHUB_RUN_ATTEMPT ?? "")) {
        throw new Error("GITHUB_RUN_NUMBER and GITHUB_RUN_ATTEMPT must both be positive integers")
      }
      buildNumber = `${env.GITHUB_RUN_NUMBER}.${env.GITHUB_RUN_ATTEMPT}`
    } else {
      // Local smoke builds need no shared counter. Set IOS_BUILD_NUMBER when
      // making another local distribution of the same marketing version.
      buildNumber = "1"
    }
  }
  if (!/^[1-9]\d*(?:\.(?:0|[1-9]\d*)){0,2}$/u.test(buildNumber)) {
    throw new Error("IOS_BUILD_NUMBER must contain one to three non-negative integers, beginning with a positive integer")
  }
  return { bundleId: "ai.yetanother.deskfleet", version: core, buildNumber, ipa: "App.ipa" }
}

function signingConfiguration(env: NodeJS.ProcessEnv): IosSigning {
  const required = (name: string): string => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`Missing prepared iOS signing setting: ${name}`)
    return value
  }
  return {
    teamId: required("APPLE_TEAM_ID"),
    identity: required("DESKFLEET_IOS_SIGNING_IDENTITY"),
    appProfile: required("DESKFLEET_IOS_APP_PROFILE_UUID"),
    broadcastProfile: required("DESKFLEET_IOS_BROADCAST_PROFILE_UUID"),
  }
}

function exportOptions(signing: IosSigning): string {
  const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>signingStyle</key><string>manual</string>
  <key>teamID</key><string>${xml(signing.teamId)}</string>
  <key>signingCertificate</key><string>${xml(signing.identity)}</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>ai.yetanother.deskfleet</key><string>${xml(signing.appProfile)}</string>
    <key>ai.yetanother.deskfleet.BroadcastUpload</key><string>${xml(signing.broadcastProfile)}</string>
  </dict>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
`
}

export async function runLoggedCommand(command: string, args: string[], cwd: string, logPath: string): Promise<void> {
  const log = openSync(logPath, "w")
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
      child.stdout.on("data", (chunk: Buffer) => { writeSync(log, chunk); process.stdout.write(chunk) })
      child.stderr.on("data", (chunk: Buffer) => { writeSync(log, chunk); process.stderr.write(chunk) })
      child.once("error", reject)
      child.once("close", (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`${command} ${args.includes("-exportArchive") ? "export" : "archive"} failed (${signal ?? code}); see ${logPath}`))
      })
    })
  } finally {
    closeSync(log)
  }
}

export async function packageIosRelease(
  repoRoot: string,
  signed: boolean,
  env: NodeJS.ProcessEnv = process.env,
  run: typeof runLoggedCommand = runLoggedCommand,
): Promise<void> {
  const release = iosRelease(env.IOS_VERSION_NAME?.trim() || readReleaseVersions(repoRoot).root, env)
  const signing = signed ? signingConfiguration(env) : undefined
  const iosAppDir = join(repoRoot, "apps/web/ios/App")
  const archivePath = join(iosAppDir, "App.xcarchive")
  const exportDir = join(iosAppDir, "output")
  const exportOptionsPath = join(iosAppDir, "ExportOptions.plist")
  const diagnosticsDir = join(iosAppDir, "diagnostics")
  for (const directory of [archivePath, exportDir, diagnosticsDir]) rmSync(directory, { recursive: true, force: true })
  mkdirSync(diagnosticsDir, { recursive: true })

  await run("xcodebuild", [
    "-project", "App.xcodeproj",
    "-scheme", "App",
    "-destination", "generic/platform=iOS",
    "-configuration", "Release",
    "-archivePath", archivePath,
    "-resultBundlePath", join(diagnosticsDir, "archive.xcresult"),
    `MARKETING_VERSION=${release.version}`,
    `CURRENT_PROJECT_VERSION=${release.buildNumber}`,
    ...(signing
      ? [
          `DEVELOPMENT_TEAM=${signing.teamId}`,
          // Only the two application targets reference these settings. A global
          // PROVISIONING_PROFILE_SPECIFIER would also reach SwiftPM libraries.
          `DESKFLEET_IOS_SIGNING_IDENTITY=${signing.identity}`,
          `DESKFLEET_IOS_APP_PROFILE_UUID=${signing.appProfile}`,
          `DESKFLEET_IOS_BROADCAST_PROFILE_UUID=${signing.broadcastProfile}`,
        ]
      : ["CODE_SIGNING_ALLOWED=NO"]),
    "archive",
  ], iosAppDir, join(diagnosticsDir, "archive.log"))

  if (!signing) return
  mkdirSync(exportDir, { recursive: true })
  writeFileSync(exportOptionsPath, exportOptions(signing))
  try {
    await run("xcodebuild", [
      "-exportArchive", "-archivePath", archivePath,
      "-exportOptionsPlist", exportOptionsPath,
      "-exportPath", exportDir,
    ], iosAppDir, join(diagnosticsDir, "export.log"))
    if (!existsSync(join(exportDir, release.ipa))) throw new Error(`iOS export did not produce ${release.ipa}`)
    writeFileSync(join(exportDir, "release.json"), `${JSON.stringify(release, null, 2)}\n`)
    rmSync(archivePath, { recursive: true, force: true })
  } finally {
    // Keep a failed archive until the job ends so export failures remain
    // inspectable. CI uploads diagnostics, never the archive or signing assets.
    rmSync(exportOptionsPath, { force: true })
  }
}

if (import.meta.main) {
  await packageIosRelease(resolve(import.meta.dirname, ".."), process.argv.includes("--signed") || process.env.DESKFLEET_IOS_SIGNED === "1")
}
