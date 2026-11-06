import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../", import.meta.url))
const output = join(root, "apps/daemon/dist")
const bundle = join(output, "daemon.cjs")
const addon = join(root, "crates/node/deskfleet.node")

mkdirSync(output, { recursive: true })
await build({
  absWorkingDir: root,
  entryPoints: ["apps/daemon/src/main.ts"],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  define: {
    "import.meta.dirname": "__dirname",
    "import.meta.url": "__deskfleet_module_url",
  },
  banner: { js: "const __deskfleet_module_url = require('node:url').pathToFileURL(__filename).href;" },
})

const config = join(output, "sea-config.json")
const blob = join(output, "sea-prep.blob")
const executable = join(output, process.platform === "win32" ? "deskfleet-daemon.exe" : "deskfleet-daemon")
writeFileSync(config, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  assets: { "deskfleet.node": addon },
}, null, 2) + "\n")
execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" })
copyFileSync(process.execPath, executable)
chmodSync(executable, 0o755)

if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", executable], { stdio: "inherit" })
const postject = createRequire(import.meta.url).resolve("postject/dist/cli.js")
const args = [postject, executable, "NODE_SEA_BLOB", blob,
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"]
if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA")
execFileSync(process.execPath, args, { stdio: "inherit" })
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", executable], { stdio: "inherit" })
console.log(executable)
