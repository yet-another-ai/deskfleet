import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

export const ALL_IOS_VIEWER_TARGETS = ["aarch64-apple-ios", "aarch64-apple-ios-sim"] as const
export type IosViewerTarget = (typeof ALL_IOS_VIEWER_TARGETS)[number]

/** Resolve the iOS Rust targets to build; defaults to both device and simulator slices. */
export function iosViewerTargets(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): readonly IosViewerTarget[] {
  const cliTargets: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--target") {
      const value = argv[++i]
      if (!value) throw new Error("--target requires an iOS Rust target triple")
      cliTargets.push(...value.split(","))
    } else if (arg?.startsWith("--target=")) {
      cliTargets.push(...arg.slice("--target=".length).split(","))
    }
  }
  const raw = cliTargets.length > 0
    ? cliTargets
    : env.DESKFLEET_IOS_TARGETS?.trim()
      ? env.DESKFLEET_IOS_TARGETS.split(",")
      : [...ALL_IOS_VIEWER_TARGETS]
  const selected: IosViewerTarget[] = []
  for (const item of raw) {
    const trimmed = item.trim()
    if (!trimmed) continue
    if (!(ALL_IOS_VIEWER_TARGETS as readonly string[]).includes(trimmed)) {
      throw new Error(`Unsupported iOS viewer target "${trimmed}"; expected one of: ${ALL_IOS_VIEWER_TARGETS.join(", ")}`)
    }
    const target = trimmed as IosViewerTarget
    if (!selected.includes(target)) selected.push(target)
  }
  if (selected.length === 0) {
    throw new Error(`Select at least one iOS viewer target (${ALL_IOS_VIEWER_TARGETS.join(", ")})`)
  }
  return selected
}

if (import.meta.main) {
  if (process.env.CAPACITOR_PLATFORM_NAME && process.env.CAPACITOR_PLATFORM_NAME !== "ios") {
    process.exit(0)
  }

  const repoRoot = resolve(import.meta.dirname, "..")
  const release = process.argv.includes("--release") || process.env.DESKFLEET_IOS_RELEASE === "1"
  const profile = release ? "release" : "debug"
  const targets = iosViewerTargets(process.env, process.argv.slice(2))

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
    const sdk = target.endsWith("-sim") ? "iphonesimulator" : "iphoneos"
    const sdkRoot = execFileSync("xcrun", ["--sdk", sdk, "--show-sdk-path"], { encoding: "utf8" }).trim()
    const clang = execFileSync("xcrun", ["--sdk", sdk, "--find", "clang"], { encoding: "utf8" }).trim()
    const targetEnv = target.replaceAll("-", "_")
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
          SDKROOT: sdkRoot,
          [`CARGO_TARGET_${targetEnv.toUpperCase()}_LINKER`]: clang,
          [`CC_${targetEnv}`]: clang,
          IPHONEOS_DEPLOYMENT_TARGET: "16.0",
          ...(release
            ? {
                CARGO_PROFILE_RELEASE_DEBUG: "line-tables-only",
                CARGO_PROFILE_RELEASE_STRIP: "none",
              }
            : {}),
        },
      },
    )
  }

  const frameworksDir = join(repoRoot, "packages/capacitor-bridge/ios/Frameworks")
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

  console.log(`Staged ${xcframeworkDir} (${targets.join(", ")})`)
}
