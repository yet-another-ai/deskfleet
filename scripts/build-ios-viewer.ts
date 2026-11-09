import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dirname, "..")
const release = process.argv.includes("--release")
const profile = release ? "release" : "debug"
const targets = ["aarch64-apple-ios", "aarch64-apple-ios-sim"] as const

const installed = execFileSync("rustup", ["target", "list", "--installed"], {
  cwd: repoRoot,
  encoding: "utf8",
})
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(Boolean)

const missing = targets.filter(target => !installed.includes(target))
if (missing.length > 0) {
  execFileSync("rustup", ["target", "add", ...missing], {
    cwd: repoRoot,
    stdio: "inherit",
  })
}

for (const target of targets) {
  execFileSync(
    "cargo",
    [
      "build",
      "-p",
      "deskfleet-desktop-viewer",
      "--lib",
      "--target",
      target,
      "--locked",
      ...(release ? ["--release"] : []),
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        IPHONEOS_DEPLOYMENT_TARGET: "16.0",
      },
    },
  )
}

const frameworksDir = join(repoRoot, "packages/capacitor-native-desktop/ios/Frameworks")
const xcframeworkDir = join(frameworksDir, "DeskfleetDesktopViewerFFI.xcframework")
mkdirSync(frameworksDir, { recursive: true })
rmSync(xcframeworkDir, { recursive: true, force: true })

const libraries = targets.flatMap(target => [
  "-library",
  join(repoRoot, "target", target, profile, "libdeskfleet_desktop_viewer.a"),
])

execFileSync("xcodebuild", ["-create-xcframework", ...libraries, "-output", xcframeworkDir], {
  cwd: repoRoot,
  stdio: "inherit",
})

console.log(`Staged ${xcframeworkDir}`)
