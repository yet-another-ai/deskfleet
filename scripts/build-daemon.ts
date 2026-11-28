import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const [target, ...extra] = process.argv.slice(2)
if (extra.length || (target !== undefined && target !== "macos-x64")) {
  throw new Error("Usage: node scripts/build-daemon.ts [macos-x64]")
}

const macIntel = target === "macos-x64"
if (macIntel && process.platform !== "darwin") throw new Error("The macOS x64 daemon must be packaged on macOS")

const output = join(root, "apps/daemon/dist", target ?? "")
const executable = join(output, process.platform === "win32" ? "deskfleet-daemon.exe" : "deskfleet-daemon")

function verifyIntelArchitecture(path: string): void {
  const architectures = execFileSync("lipo", ["-archs", path], { encoding: "utf8" }).trim()
  if (architectures !== "x86_64") throw new Error(`${path} must be x86_64 (found ${architectures})`)
}

mkdirSync(output, { recursive: true })
if (macIntel) verifyIntelArchitecture(join(output, "deskfleet.node"))
execFileSync("bun", [
  "build", "apps/daemon/src/standalone.ts", "--compile",
  "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
  "--define", `DESKFLEET_TARGET_MACOS_X64=${macIntel}`,
  "--define", `__DESKFLEET_ADHD_SKILL__=${JSON.stringify(readFileSync(join(root, ".agents/skills/i-have-adhd/SKILL.md"), "utf8"))}`,
  ...(macIntel ? ["--target=bun-darwin-x64-baseline"] : []),
  "--outfile", executable,
], { cwd: root, stdio: "inherit" })

if (macIntel) verifyIntelArchitecture(executable)
if (process.platform === "darwin") {
  execFileSync("codesign", ["--force", "--sign", "-", executable], { stdio: "inherit" })
}
