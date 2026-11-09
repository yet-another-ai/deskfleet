import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

const [output] = process.argv.slice(2)
assert.ok(output, "Usage: node scripts/smoke-darwin-package.ts <package-root>")
assert.equal(process.platform, "darwin", "The package smoke supports macOS")

const app = join(resolve(output), "Applications", "deskfleet.app")
for (const path of [
  "Contents/Info.plist",
  "Contents/MacOS/deskfleet",
  "Contents/Resources/app.asar",
  "Contents/Resources/dsh",
]) {
  assert.ok(existsSync(join(app, path)), `The package is missing ${path}`)
}

const info = join(app, "Contents/Info.plist")
execFileSync("plutil", ["-lint", info], { stdio: "inherit" })
// The release archive is signed and notarized by Build. Copying it into the Nix
// store must preserve every Mach-O signature.
execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" })
console.log(`Verified the signed macOS app bundle at ${app}`)
