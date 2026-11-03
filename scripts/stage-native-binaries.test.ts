import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

const stages = [
  ...["linux", "darwin", "win32"].map(platform => ({
    script: "stage-native-viewer.ts", platform, output: "native",
    binary: platform === "win32" ? "deskfleet-viewer.exe" : "deskfleet-viewer",
  })),
  { script: "stage-windows-service.ts", platform: "win32", output: "windows", binary: "deskfleet-desktop-service.exe" },
]

for (const stage of stages) {
  for (const mode of ["local", "prebuilt", "missing"] as const) {
    test(`${stage.script} on ${stage.platform}: ${mode}`, context => {
      const root = mkdtempSync(join(tmpdir(), "deskfleet-native-staging-"))
      context.after(() => rmSync(root, { recursive: true, force: true }))
      const scripts = join(root, "apps/desktop/scripts")
      const release = join(root, "target/fixture-target/release")
      mkdirSync(scripts, { recursive: true })
      mkdirSync(release, { recursive: true })
      const script = join(scripts, stage.script)
      copyFileSync(join(import.meta.dirname, "../apps/desktop/scripts", stage.script), script)
      const binary = join(release, stage.binary)
      const calls = join(root, "cargo-calls")
      if (mode !== "missing") writeFileSync(binary, "existing binary")

      // Run the real staging entry point with a fake compiler, without compiling
      // Rust or changing this checkout's build output. Each OS branch is isolated.
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import childProcess from "node:child_process"
        import { writeFileSync } from "node:fs"
        import { syncBuiltinESMExports } from "node:module"
        Object.defineProperty(process, "platform", { value: ${JSON.stringify(stage.platform)} })
        childProcess.execFileSync = (command, args) => {
          if (command === "rustc") return "fixture-target\\n"
          if (command !== "cargo") throw new Error("Unexpected command: " + command)
          writeFileSync(${JSON.stringify(calls)}, JSON.stringify(args))
          writeFileSync(${JSON.stringify(binary)}, "freshly compiled binary")
        }
        syncBuiltinESMExports()
        await import(${JSON.stringify(pathToFileURL(script).href)})
      `], {
        encoding: "utf8",
        env: { ...process.env, DESKFLEET_NATIVE_PREBUILT: mode === "local" ? undefined : "1" },
      })
      assert.ifError(result.error)
      const output = join(root, "apps/desktop/out", stage.output, stage.binary)
      if (mode === "missing") {
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /ENOENT/)
        assert.equal(existsSync(output), false)
      } else {
        assert.equal(result.status, 0, result.stderr)
        assert.equal(readFileSync(output, "utf8"), mode === "local" ? "freshly compiled binary" : "existing binary")
      }
      assert.equal(existsSync(calls), mode === "local")
    })
  }
}
