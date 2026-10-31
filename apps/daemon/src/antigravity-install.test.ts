import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { antigravityInstallDirectory, antigravityInstaller } from "./antigravity-install.ts"

const execute = promisify(execFile)
const linuxChecksum = "923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b"

test("Antigravity selects official archives for every supported target", () => {
  for (const [platform, directory, archivePlatform] of [["darwin", "macos", "darwin"], ["linux", "linux", "linux"], ["win32", "windows", "windows"]] as const) {
    for (const arch of ["x64", "arm64"]) {
      const launch = antigravityInstaller({ platform, arch, shell: "/shell", env: {}, home: "/home/user" })
      assert.notEqual(typeof launch, "string")
      if (typeof launch === "string") continue
      assert.equal(launch.command, "/shell")
      assert.ok(launch.args.at(-1)!.includes(`https://dl.google.com/agy-extensions/releases/${directory}/agy-acp-server-1.4.5-${archivePlatform}-${arch === "x64" ? "x86_64" : "arm64"}.zip`))
      assert.match(launch.args.at(-1)!, /[a-f0-9]{64}/u)
    }
  }
  assert.match(antigravityInstaller({ platform: "linux", arch: "s390x", shell: "/bin/bash", env: {}, home: "/home/user" }) as string, /unavailable/u)
})

test("Antigravity installation directories honor machine-local data roots", () => {
  assert.equal(antigravityInstallDirectory({ platform: "linux", env: {}, home: "/home/user" }), "/home/user/.local/share/deskfleet/providers/antigravity")
  assert.equal(antigravityInstallDirectory({ platform: "darwin", env: { XDG_DATA_HOME: "/custom/data" }, home: "/home/user" }), "/custom/data/deskfleet/providers/antigravity")
  assert.equal(antigravityInstallDirectory({ platform: "win32", env: { LOCALAPPDATA: "C:\\custom" }, home: "C:\\Users\\user" }), "C:\\custom\\DeskFleet\\providers\\antigravity")
  assert.equal(antigravityInstallDirectory({ platform: "win32", env: {}, home: "C:\\Users\\user" }), "C:\\Users\\user\\AppData\\Local\\DeskFleet\\providers\\antigravity")
  const launch = antigravityInstaller({ platform: "win32", arch: "arm64", shell: "pwsh", env: { LOCALAPPDATA: "C:\\user's $files" }, home: "C:\\Users\\user" })
  assert.notEqual(typeof launch, "string")
  if (typeof launch !== "string") assert.ok(launch.args.at(-1)!.includes("$destination = 'C:\\user''s $files\\DeskFleet\\providers\\antigravity'"))
})

async function installerFixture() {
  const directory = await mkdtemp(join(tmpdir(), "df-antigravity-install-"))
  const commands = join(directory, "commands")
  await mkdir(commands)
  const scripts = {
    curl: 'printf "archive" > "$3"',
    sha256sum: 'printf "%s  %s\\n" "$TEST_CHECKSUM" "$1"',
    unzip: 'mkdir -p "$4/assets"; printf "server" > "$4/agy_acp_server.par"; printf "asset" > "$4/assets/resource"; if [ "$TEST_MISSING_HARNESS" != "1" ]; then printf "harness" > "$4/localharness_external"; fi',
  }
  for (const [command, script] of Object.entries(scripts)) await writeFile(join(commands, command), `#!/bin/sh\nset -eu\n${script}\n`, { mode: 0o700 })
  const ctx = { platform: "linux" as const, arch: "x64", shell: "/bin/bash", env: { XDG_DATA_HOME: join(directory, "data' $value;[]") }, home: directory }
  const launch = antigravityInstaller(ctx)
  if (typeof launch === "string") throw new Error(launch)
  const env = { ...process.env, PATH: `${commands}:/usr/bin:/bin`, TEST_CHECKSUM: linuxChecksum, TEST_MISSING_HARNESS: "0" }
  return { directory, launch, destination: antigravityInstallDirectory(ctx), env }
}

test("Antigravity installer retains the complete runtime and treats the destination as data", { skip: process.platform === "win32" }, async t => {
  const f = await installerFixture()
  t.after(() => rm(f.directory, { recursive: true, force: true }))
  await execute(f.launch.command, f.launch.args, { cwd: f.directory, env: f.env, timeout: 5_000 })
  assert.equal(await readFile(join(f.destination, "agy_acp_server.par"), "utf8"), "server")
  assert.equal(await readFile(join(f.destination, "localharness_external"), "utf8"), "harness")
  assert.equal(await readFile(join(f.destination, "assets", "resource"), "utf8"), "asset")
  assert.ok((await stat(join(f.destination, "agy_acp_server.par"))).mode & 0o100)
  assert.ok((await stat(join(f.destination, "localharness_external"))).mode & 0o100)
})

test("Antigravity installer rejects corrupted or incomplete downloads before changing an installation", { skip: process.platform === "win32" }, async t => {
  const f = await installerFixture()
  t.after(() => rm(f.directory, { recursive: true, force: true }))
  await mkdir(f.destination, { recursive: true })
  await writeFile(join(f.destination, "agy_acp_server.par"), "previous")
  await assert.rejects(execute(f.launch.command, f.launch.args, { cwd: f.directory, env: { ...f.env, TEST_CHECKSUM: "wrong" }, timeout: 5_000 }), /checksum mismatch/u)
  assert.equal(await readFile(join(f.destination, "agy_acp_server.par"), "utf8"), "previous")
  await assert.rejects(execute(f.launch.command, f.launch.args, { cwd: f.directory, env: { ...f.env, TEST_MISSING_HARNESS: "1" }, timeout: 5_000 }), /missing localharness_external/u)
  assert.equal(await readFile(join(f.destination, "agy_acp_server.par"), "utf8"), "previous")
})
