import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const output = join(root, "apps/daemon/dist")
const executable = join(output, process.platform === "win32" ? "deskfleet-daemon.exe" : "deskfleet-daemon")

mkdirSync(output, { recursive: true })
execFileSync("bun", [
  "build", "apps/daemon/src/standalone.ts", "--compile",
  "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
  "--outfile", executable,
], { cwd: root, stdio: "inherit" })

if (process.platform === "darwin") {
  execFileSync("codesign", ["--force", "--sign", "-", executable], { stdio: "inherit" })
}
