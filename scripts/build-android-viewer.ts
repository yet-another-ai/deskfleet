import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

export const MIN_ANDROID_API = 34
export const MIN_NDK_MAJOR = 28
const PAGE_SIZE_16KB = 0x4000

export interface NdkRevision {
  path: string
  revision: string
  prerelease: boolean
  numbers: [number, number, number]
}

export function parseNdkRevision(ndkPath: string): NdkRevision | null {
  if (!existsSync(ndkPath)) return null
  const sourceProps = join(ndkPath, "source.properties")
  let revision = basename(ndkPath)
  if (existsSync(sourceProps)) {
    const match = readFileSync(sourceProps, "utf8").match(/^\s*Pkg\.Revision\s*=\s*(.+?)\s*$/mu)
    if (match?.[1]) revision = match[1]
  }
  const [base, suffix] = revision.split("-", 2)
  const parts = (base ?? "").split(".")
  if (parts.length < 1 || !parts.every(part => /^\d+$/u.test(part))) return null
  const major = Number(parts[0])
  const minor = Number(parts[1] ?? 0)
  const build = Number(parts[2] ?? 0)
  if (major < MIN_NDK_MAJOR) return null
  return { path: ndkPath, revision, prerelease: Boolean(suffix), numbers: [major, minor, build] }
}

function compareNdkRevisions(a: NdkRevision, b: NdkRevision): number {
  if (a.prerelease !== b.prerelease) return a.prerelease ? 1 : -1
  for (let i = 0; i < 3; i++) {
    if (a.numbers[i] !== b.numbers[i]) return b.numbers[i]! - a.numbers[i]!
  }
  return 0
}

export function findNdkRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  for (const key of ["ANDROID_NDK_HOME", "ANDROID_NDK_ROOT", "NDK_HOME", "ANDROID_NDK_LATEST_HOME"]) {
    const candidate = env[key]
    if (candidate && parseNdkRevision(candidate)) return candidate
  }
  // When ANDROID_HOME / ANDROID_SDK_ROOT are set, search only those roots.
  // Merging in later defaults (for example /usr/local/lib/android/sdk on
  // GitHub-hosted runners) can override an explicit SDK with a newer NDK.
  const explicitSdks = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter((v): v is string => Boolean(v))
  const sdks = [
    ...new Set(
      explicitSdks.length > 0
        ? explicitSdks
        : [join(home, "Library/Android/sdk"), join(home, "Android/Sdk"), "/usr/local/lib/android/sdk"],
    ),
  ]

  for (const sdk of sdks) {
    const ndkDir = join(sdk, "ndk")
    if (!existsSync(ndkDir)) continue
    const installed: NdkRevision[] = []
    for (const entry of readdirSync(ndkDir)) {
      if (entry.startsWith(".")) continue
      const parsed = parseNdkRevision(join(ndkDir, entry))
      if (parsed) installed.push(parsed)
    }
    installed.sort(compareNdkRevisions)
    if (installed[0]) return installed[0].path
  }
  throw new Error(`Could not locate Android NDK r${MIN_NDK_MAJOR} or newer. Install NDK ${MIN_NDK_MAJOR}+ under Android SDK or set ANDROID_NDK_HOME.`)
}

export function buildAndroidViewerEnv(
  baseEnv: NodeJS.ProcessEnv,
  ndkRoot: string,
  binDir: string,
  clang: string,
  release: boolean,
): NodeJS.ProcessEnv {
  const existingRustflags = baseEnv.CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS ?? baseEnv.RUSTFLAGS ?? ""
  const pageSizeFlag = `-C link-arg=-Wl,-z,max-page-size=${PAGE_SIZE_16KB}`
  const rustflags = existingRustflags ? `${existingRustflags} ${pageSizeFlag}` : pageSizeFlag
  const exe = process.platform === "win32" ? ".exe" : ""
  return {
    ...baseEnv,
    ANDROID_NDK_HOME: ndkRoot,
    ANDROID_NDK_ROOT: ndkRoot,
    CC_aarch64_linux_android: clang,
    CXX_aarch64_linux_android: `${clang}++`,
    AR_aarch64_linux_android: join(binDir, `llvm-ar${exe}`),
    CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: clang,
    CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS: rustflags,
    CMAKE_TOOLCHAIN_FILE_aarch64_linux_android: join(ndkRoot, "build/cmake/android.toolchain.cmake"),
    CMAKE_ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES: "ON",
    ANDROID_ABI: "arm64-v8a",
    ANDROID_PLATFORM: `android-${MIN_ANDROID_API}`,
    ...(release
      ? {
          // Retain DWARF line tables and ELF symbols in the staged .so so AGP
          // packages Play Console debug symbols while stripping the shipped APK.
          CARGO_PROFILE_RELEASE_DEBUG: "line-tables-only",
          CARGO_PROFILE_RELEASE_STRIP: "none",
        }
      : {}),
  }
}

export function verifyElfLoadAlignment(readelfOutput: string, soPath: string): void {
  const alignments = [...readelfOutput.matchAll(/^\s*LOAD\s+.+\s+(0x[0-9a-fA-F]+)\s*$/gmu)]
    .map(match => Number.parseInt(match[1]!, 16))
  if (alignments.length === 0) {
    throw new Error(`No ELF LOAD segments found in ${soPath}`)
  }
  const unaligned = alignments.find(align => align < PAGE_SIZE_16KB)
  if (unaligned !== undefined) {
    throw new Error(`${soPath} has LOAD segment alignment 0x${unaligned.toString(16)}; Google Play requires at least 0x${PAGE_SIZE_16KB.toString(16)} (16 KB)`)
  }
}

if (import.meta.main) {
  if (process.env.CAPACITOR_PLATFORM_NAME && process.env.CAPACITOR_PLATFORM_NAME !== "android") {
    process.exit(0)
  }

  const repoRoot = resolve(import.meta.dirname, "..")
  const release = process.argv.includes("--release") || process.env.DESKFLEET_ANDROID_RELEASE === "1"
  const ndkRoot = findNdkRoot()
  const prebuiltDir = join(ndkRoot, "toolchains/llvm/prebuilt")
  const host = readdirSync(prebuiltDir).find(n => !n.startsWith("."))
  if (!host) throw new Error(`No LLVM prebuilt toolchain found under ${prebuiltDir}`)
  const binDir = join(prebuiltDir, host, "bin")
  const cmdExt = process.platform === "win32" ? ".cmd" : ""
  const exeExt = process.platform === "win32" ? ".exe" : ""
  const clang = join(binDir, `aarch64-linux-android${MIN_ANDROID_API}-clang${cmdExt}`)
  if (!existsSync(clang)) {
    throw new Error(`Missing Android API ${MIN_ANDROID_API} clang wrapper at ${clang}`)
  }

  execFileSync(
    "cargo",
    ["build", "-p", "deskfleet-desktop-viewer", "--lib", "--target", "aarch64-linux-android", "--locked", ...(release ? ["--release"] : [])],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: buildAndroidViewerEnv(process.env, ndkRoot, binDir, clang, release),
    },
  )

  const builtSo = join(repoRoot, "target/aarch64-linux-android", release ? "release" : "debug", "libdeskfleet_desktop_viewer.so")
  const readelfOutput = execFileSync(join(binDir, `llvm-readelf${exeExt}`), ["-l", builtSo], { encoding: "utf8" })
  verifyElfLoadAlignment(readelfOutput, builtSo)

  const outDir = join(repoRoot, "packages/capacitor-bridge/android/src/main/jniLibs/arm64-v8a")
  mkdirSync(outDir, { recursive: true })
  const targetSo = join(outDir, "libdeskfleet_desktop_viewer.so")
  copyFileSync(builtSo, targetSo)
  console.log(`Staged ${targetSo} (NDK ${basename(ndkRoot)}, API ${MIN_ANDROID_API}, 16 KB aligned)`)
}
