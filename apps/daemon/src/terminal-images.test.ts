import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import test from "node:test"
import { promisify } from "node:util"
import { imageLauncher, terminalImageEnvironment } from "./terminal-image-launcher.ts"
import { ICAT_FILE_BYTES, runIcat, terminalImageSequence } from "./terminal-images.ts"

const exec = promisify(execFile)
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==", "base64")

function streamCapture() {
  const chunks: Buffer[] = []
  const stream = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done() } })
  return { stream, text: () => Buffer.concat(chunks).toString() }
}

async function invoke(args: string[], input: Buffer = png) {
  const output = streamCapture()
  const error = streamCapture()
  const code = await runIcat(args, { input: Readable.from([input]), output: output.stream, error: error.stream })
  return { code, output: output.text(), error: error.text() }
}

test("icat emits a legacy inline image with the original bytes from stdin or a Unicode path", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-icat-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, "截图 with spaces.png")
  await writeFile(path, png)
  for (const args of [[], ["-"], [path], ["--", path]]) {
    const result = await invoke(args)
    assert.equal(result.code, 0)
    assert.equal(result.error, "")
    assert.match(result.output, /^\x1b\]1337;File=name=/u)
    assert.ok(result.output.includes(`;size=${png.length};inline=1;`))
    assert.ok(result.output.endsWith(`:${png.toString("base64")}\x07\n`))
    assert.equal(result.output.includes("MultipartFile"), false)
  }
})

test("icat reports unsupported input, options, size, and pixel limits before writing a sequence", async () => {
  const hugeDimensions = Buffer.from(png)
  hugeDimensions.writeUInt32BE(4096, 16)
  hugeDimensions.writeUInt32BE(4096, 20)
  for (const [args, input, message] of [
    [["--transfer-mode=stream"], png, /Usage/u],
    [[], Buffer.from("not an image"), /PNG, JPEG, or GIF/u],
    [[], Buffer.alloc(ICAT_FILE_BYTES + 1), /20,000,000-byte/u],
    [[], hugeDimensions, /16,777,216 pixels/u],
  ] as const) {
    const result = await invoke([...args], input)
    assert.equal(result.code, 1)
    assert.equal(result.output, "")
    assert.match(result.error, message)
  }
  const help = await invoke(["--help"])
  assert.equal(help.code, 0)
  assert.match(help.output, /Usage: icat/u)
  assert.equal(help.error, "")
})

test("JPEG frame and GIF logical dimensions accept supported static images", () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64")
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 0, 0xff, 0xd9])
  assert.ok(terminalImageSequence(gif, "one.gif").includes(`:${gif.toString("base64")}\x07`))
  assert.ok(terminalImageSequence(jpegHeader, "one.jpg").includes(`:${jpegHeader.toString("base64")}\x07`))
})

test("new terminal helper uses the bundled runtime and survives login shell initialization", async context => {
  const directory = await mkdtemp(join(tmpdir(), "df-icat-shell-"))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const env = await terminalImageEnvironment(directory)
  const path = join(directory, "image 空格.png")
  await writeFile(path, png)
  if (process.platform === "win32") {
    // Absolute path as its own argv element — not %VAR% inside one /c string —
    // so Node's CreateProcess quoting and cmd /s keep spaces/Unicode intact.
    const result = await exec(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "icat", path], {
      env: { ...process.env, ...env },
    })
    assert.ok(result.stdout.endsWith(`:${png.toString("base64")}\x07\n`))
    const launcher = await readFile(join(directory, ".shell-bin", "icat.cmd"), "utf8")
    assert.ok(launcher.includes("%DESKFLEET_ICAT_ARG_0%"))
  } else {
    for (const shell of process.platform === "darwin" ? ["/bin/zsh", "/bin/bash"] : ["/bin/bash"]) {
      const result = await exec(shell, ["-lic", 'icat "$DESKFLEET_TEST_IMAGE"'], {
        env: { ...process.env, ...env, DESKFLEET_TEST_IMAGE: path },
      })
      assert.ok(result.stdout.endsWith(`:${png.toString("base64")}\x07\n`), shell)
    }
    const launcher = await readFile(join(directory, ".shell-bin", "icat"), "utf8")
    assert.ok(launcher.includes(process.execPath))
    assert.ok(launcher.includes("--deskfleet-icat"))
  }
})

test("Electron launchers scope Node mode to the helper and quote executable paths", () => {
  const host = { command: "/Applications/Desk Fleet.app/Contents/MacOS/Desk Fleet", args: ["/app/main's.js", "--deskfleet-icat"], env: { ELECTRON_RUN_AS_NODE: "1" } }
  assert.equal(imageLauncher(host, "darwin"), `#!/bin/sh\nELECTRON_RUN_AS_NODE='1' exec '/Applications/Desk Fleet.app/Contents/MacOS/Desk Fleet' '/app/main'\\''s.js' '--deskfleet-icat' "$@"\n`)
  assert.equal(imageLauncher({ command: "C:\\Users\\测试50%\\Desk Fleet.exe", args: ["C:\\main.js", "--deskfleet-icat"], env: host.env }, "win32"), '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%DESKFLEET_ICAT_ARG_0%" "%DESKFLEET_ICAT_ARG_1%" "%DESKFLEET_ICAT_ARG_2%" %*\r\n')
})
