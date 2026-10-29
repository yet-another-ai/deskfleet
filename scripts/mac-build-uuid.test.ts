import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import macBuildUuid, { rewriteMachOUuids } from "../apps/desktop/scripts/mac-build-uuid.ts"

function executable(cpu: number): Buffer {
  const bytes = Buffer.alloc(64, 0)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(cpu, 4)
  bytes.writeUInt32LE(2, 12)
  bytes.writeUInt32LE(1, 16)
  bytes.writeUInt32LE(24, 20)
  bytes.writeUInt32LE(0x1b, 32)
  bytes.writeUInt32LE(24, 36)
  bytes.fill(0x42, 40, 56)
  bytes.fill(0xcc, 56)
  return bytes
}

test("build UUIDs distinguish app, helper, Electron build, and architecture without changing other bytes", () => {
  const original = executable(0x100000c)
  const changed = rewriteMachOUuids(original, "deskfleet/main")
  assert.notDeepEqual(changed.subarray(40, 56), original.subarray(40, 56))
  assert.deepEqual(changed.subarray(0, 40), original.subarray(0, 40))
  assert.deepEqual(changed.subarray(56), original.subarray(56))
  assert.deepEqual(changed, rewriteMachOUuids(original, "deskfleet/main"))
  const newer = Buffer.from(original)
  newer[40] = 0x43
  const uuids = [changed, rewriteMachOUuids(original, "other/main"), rewriteMachOUuids(original, "deskfleet/helper"),
    rewriteMachOUuids(executable(0x1000007), "deskfleet/main"), rewriteMachOUuids(newer, "deskfleet/main")]
  assert.equal(new Set(uuids.map(bytes => bytes.subarray(40, 56).toString("hex"))).size, 5)
})

test("universal executables retain both slices and rewrite each architecture's UUID", () => {
  const bytes = Buffer.alloc(176)
  bytes.writeUInt32BE(0xcafebabe, 0)
  bytes.writeUInt32BE(2, 4)
  bytes.writeUInt32BE(48, 16)
  bytes.writeUInt32BE(64, 20)
  bytes.writeUInt32BE(112, 36)
  bytes.writeUInt32BE(64, 40)
  executable(0x100000c).copy(bytes, 48)
  executable(0x1000007).copy(bytes, 112)
  const changed = rewriteMachOUuids(bytes, "deskfleet/main")
  assert.deepEqual(changed.subarray(0, 48), bytes.subarray(0, 48))
  assert.notDeepEqual(changed.subarray(88, 104), changed.subarray(152, 168))
  const restored = Buffer.from(changed)
  bytes.copy(restored, 88, 88, 104)
  bytes.copy(restored, 152, 152, 168)
  assert.deepEqual(restored, bytes)
})

test("missing or malformed UUID commands fail before a file can be replaced", () => {
  const noUuid = executable(0x100000c)
  noUuid.writeUInt32LE(0, 32)
  assert.throws(() => rewriteMachOUuids(noUuid, "deskfleet"), /no build UUID/)
  const invalid = executable(0x100000c)
  invalid.writeUInt32LE(100, 36)
  assert.throws(() => rewriteMachOUuids(invalid, "deskfleet"), /Invalid Mach-O load command/)
})

test("afterPack ignores non-macOS targets", async () => {
  await macBuildUuid({ electronPlatformName: "win32" } as Parameters<typeof macBuildUuid>[0])
})

test("electron-builder loads the TypeScript hook and real Electron app/helpers retain valid signatures after signing", { skip: process.platform !== "darwin", timeout: 120_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-mac-uuid-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const desktop = resolve(import.meta.dirname, "../apps/desktop")
  const require = createRequire(join(desktop, "package.json"))
  const source = dirname(dirname(dirname(require("electron") as string)))
  const app = join(directory, "DeskFleet.app")
  await cp(source, app, { recursive: true, verbatimSymlinks: true })
  const framework = join(app, "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework")
  const frameworkBefore = await readFile(framework)
  const executables = [join(app, "Contents/MacOS/Electron")]
  for (const helper of await readdir(join(app, "Contents/Frameworks"))) {
    if (helper.endsWith(".app")) executables.push(join(app, "Contents/Frameworks", helper, "Contents/MacOS", helper.slice(0, -4)))
  }
  const uuid = (path: string) => execFileSync("dwarfdump", ["--uuid", path], { encoding: "utf8" }).match(/UUID: (\S+)/)![1]!
  const before = executables.map(uuid)
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"))
  const { resolveFunction } = builderRequire("app-builder-lib/out/util/resolve.js")
  const hook = await resolveFunction("module", join(desktop, "scripts/mac-build-uuid.ts"), "afterPack", resolve(desktop, "../.."))
  await hook({ electronPlatformName: "darwin", appOutDir: directory, packager: { appInfo: { id: "io.github.yet-another-ai.deskfleet", productFilename: "DeskFleet" } } })
  const after = executables.map(uuid)
  assert.equal(new Set(after).size, executables.length)
  for (let i = 0; i < before.length; i++) assert.notEqual(after[i], before[i])
  assert.deepEqual(await readFile(framework), frameworkBefore)
  execFileSync("codesign", ["--force", "--sign", "-", "--deep", app], { stdio: "pipe" })
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "pipe" })
})
