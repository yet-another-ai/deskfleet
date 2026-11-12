import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"

const developmentInfo = {
  CFBundleIdentifier: "io.github.yet-another-ai.deskfleet.dev",
  CFBundleName: "DeskFleet Dev",
  CFBundleDisplayName: "DeskFleet Dev",
  NSMicrophoneUsageDescription: "DeskFleet uses your microphone to dictate messages.",
  NSSpeechRecognitionUsageDescription: "DeskFleet uses system speech recognition to transcribe dictated messages.",
}

/** Keep a signed development host with its own macOS privacy permission identity. */
export async function prepareDevelopmentElectron(
  executable: string,
  cacheDirectory = resolve(import.meta.dirname, "../node_modules/.cache/deskfleet-electron"),
): Promise<string> {
  if (process.platform !== "darwin") return executable

  const source = dirname(dirname(dirname(executable)))
  const sourceInfo = await readFile(join(source, "Contents/Info.plist"))
  const fingerprint = createHash("sha256").update(sourceInfo)
    .update(JSON.stringify({ source, arch: process.arch, developmentInfo })).digest("hex")
  const app = join(cacheDirectory, "DeskFleet Dev.app")
  const preparedExecutable = join(app, "Contents/MacOS", "Electron")
  const stamp = join(cacheDirectory, "fingerprint")
  if (existsSync(preparedExecutable) && existsSync(stamp) && await readFile(stamp, "utf8") === fingerprint) {
    return preparedExecutable
  }

  console.log("Preparing macOS development host with microphone and speech permissions…")
  await mkdir(cacheDirectory, { recursive: true })
  await rm(stamp, { force: true })
  await rm(app, { recursive: true, force: true })
  await cp(source, app, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  const plist = join(app, "Contents/Info.plist")
  for (const [key, value] of Object.entries(developmentInfo)) {
    execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, plist])
  }
  // Only prepare/sign when the host changes, so Vite restarts retain the same identity.
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "pipe" })
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" })
  await writeFile(stamp, fingerprint)
  return preparedExecutable
}

if (import.meta.main) {
  const executable: unknown = createRequire(import.meta.url)("electron")
  if (typeof executable !== "string") throw new TypeError("electron did not resolve to its executable path")
  console.log(await prepareDevelopmentElectron(executable))
}
