import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

function findNdkRoot(): string {
  for (const key of ["ANDROID_NDK_HOME", "ANDROID_NDK_ROOT", "NDK_HOME"]) {
    if (process.env[key] && existsSync(process.env[key]!)) return process.env[key]!
  }
  const sdks = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library/Android/sdk"),
    join(homedir(), "Android/Sdk"),
    "/usr/local/lib/android/sdk",
  ].filter((v): v is string => Boolean(v))

  for (const sdk of sdks) {
    const ndkDir = join(sdk, "ndk")
    if (!existsSync(ndkDir)) continue
    const latest = readdirSync(ndkDir).filter(n => !n.startsWith(".")).sort().at(-1)
    if (latest) return join(ndkDir, latest)
  }
  throw new Error("Could not locate Android NDK. Set ANDROID_NDK_HOME or install NDK under Android SDK.")
}

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
const clang = join(binDir, "aarch64-linux-android28-clang")

execFileSync(
  "cargo",
  ["build", "-p", "deskfleet-desktop-viewer", "--lib", "--target", "aarch64-linux-android", "--locked", ...(release ? ["--release"] : [])],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ANDROID_NDK_HOME: ndkRoot,
      ANDROID_NDK_ROOT: ndkRoot,
      CC_aarch64_linux_android: clang,
      CXX_aarch64_linux_android: `${clang}++`,
      AR_aarch64_linux_android: join(binDir, "llvm-ar"),
      CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: clang,
      CMAKE_TOOLCHAIN_FILE_aarch64_linux_android: join(ndkRoot, "build/cmake/android.toolchain.cmake"),
      ANDROID_ABI: "arm64-v8a",
      ANDROID_PLATFORM: "android-28",
    },
  },
)

const outDir = join(repoRoot, "packages/capacitor-bridge/android/src/main/jniLibs/arm64-v8a")
mkdirSync(outDir, { recursive: true })
const targetSo = join(outDir, "libdeskfleet_desktop_viewer.so")
copyFileSync(join(repoRoot, "target/aarch64-linux-android", release ? "release" : "debug", "libdeskfleet_desktop_viewer.so"), targetSo)
console.log(`Staged ${targetSo}`)
