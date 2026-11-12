import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { prepareDevelopmentElectron } from "../apps/desktop/scripts/dev-electron.ts"

test("non-macOS development keeps the installed executable", { skip: process.platform === "darwin" }, async () => {
  assert.equal(await prepareDevelopmentElectron("electron-original"), "electron-original")
})

test("macOS development host has speech declarations, a valid signature, and survives reuse", {
  skip: process.platform !== "darwin", timeout: 120_000,
}, async context => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-dev-electron-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url))
  const original = require("electron") as string
  const originalPlist = join(dirname(dirname(dirname(original))), "Contents/Info.plist")
  const originalInfo = await readFile(originalPlist)

  const executable = await prepareDevelopmentElectron(original, directory)
  const app = dirname(dirname(dirname(executable)))
  const plist = join(app, "Contents/Info.plist")
  const info = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" }))
  assert.equal(info.CFBundleIdentifier, "io.github.yet-another-ai.deskfleet.dev")
  assert.equal(info.CFBundleDisplayName, "DeskFleet Dev")
  assert.match(info.NSMicrophoneUsageDescription, /microphone/)
  assert.match(info.NSSpeechRecognitionUsageDescription, /speech recognition/)
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  assert.equal(execFileSync(executable, ["--version"], { env, encoding: "utf8", timeout: 20_000 }).trim(), `v${info.CFBundleShortVersionString}`)

  const signature = join(app, "Contents/_CodeSignature/CodeResources")
  const before = await stat(signature)
  assert.equal(await prepareDevelopmentElectron(original, directory), executable)
  const after = await stat(signature)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.deepEqual(await readFile(originalPlist), originalInfo)
})
