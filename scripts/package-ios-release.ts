import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { readReleaseVersions } from "./release-version.ts"

const repoRoot = resolve(import.meta.dirname, "..")
const iosAppDir = join(repoRoot, "apps/web/ios/App")
const signed = process.argv.includes("--signed") || process.env.DESKFLEET_IOS_SIGNED === "1"
const version = process.env.IOS_VERSION_NAME?.trim() || readReleaseVersions(repoRoot).root
const [core = "0.0.0", suffix] = version.split("-", 2)
const [major = 0, minor = 0, patch = 0] = core.split(".").map(n => Number.parseInt(n, 10) || 0)
const pre = suffix === undefined
  ? 999
  : Math.min(998, Math.max(1, Number.parseInt(suffix.match(/(\d+)$/u)?.[1] ?? "1", 10) || 1))
const buildNumber = process.env.IOS_BUILD_NUMBER?.trim() || String(major * 10_000_000 + minor * 100_000 + patch * 1_000 + pre)

const archivePath = join(iosAppDir, "App.xcarchive")
const exportDir = join(iosAppDir, "output")
const exportOptionsPath = join(iosAppDir, "ExportOptions.plist")
rmSync(archivePath, { recursive: true, force: true })
rmSync(exportDir, { recursive: true, force: true })

const authArgs = signed
  ? [
      "-allowProvisioningUpdates",
      "-authenticationKeyPath",
      process.env.APPLE_API_KEY_PATH!,
      "-authenticationKeyID",
      process.env.APPLE_API_KEY_ID!,
      "-authenticationKeyIssuerID",
      process.env.APPLE_API_ISSUER!,
    ]
  : []

execFileSync(
  "xcodebuild",
  [
    "-project",
    "App.xcodeproj",
    "-scheme",
    "App",
    "-destination",
    "generic/platform=iOS",
    "-configuration",
    "Release",
    "-archivePath",
    archivePath,
    `MARKETING_VERSION=${core}`,
    `CURRENT_PROJECT_VERSION=${buildNumber}`,
    ...(signed ? [`DEVELOPMENT_TEAM=${process.env.APPLE_TEAM_ID}`, ...authArgs] : ["CODE_SIGNING_ALLOWED=NO"]),
    "archive",
  ],
  { cwd: iosAppDir, stdio: "inherit" },
)

if (signed) {
  mkdirSync(exportDir, { recursive: true })
  writeFileSync(
    exportOptionsPath,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>method</key>\n\t<string>app-store-connect</string>\n\t<key>signingStyle</key>\n\t<string>automatic</string>\n\t<key>teamID</key>\n\t<string>${process.env.APPLE_TEAM_ID}</string>\n\t<key>uploadSymbols</key>\n\t<true/>\n</dict>\n</plist>\n`,
  )
  try {
    execFileSync(
      "xcodebuild",
      ["-exportArchive", "-archivePath", archivePath, "-exportOptionsPlist", exportOptionsPath, "-exportPath", exportDir, ...authArgs],
      { cwd: iosAppDir, stdio: "inherit" },
    )
  } finally {
    rmSync(exportOptionsPath, { force: true })
    rmSync(archivePath, { recursive: true, force: true })
  }
}
