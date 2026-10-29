import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createTerminal } from "@deskfleet/native"
import { TerminalSessions } from "./terminals.ts"

function zsh(): string | undefined {
  if (process.platform === "win32") return undefined
  try { return execFileSync("/bin/sh", ["-c", "command -v zsh"], { encoding: "utf8" }).trim() || undefined }
  catch { return undefined }
}

const shell = zsh()
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==", "base64")

for (const startup of ["custom", "redirected", "home"]) {
  test(`default zsh terminals retain icat with ${startup} startup configuration`, {
    skip: shell ? false : "zsh is unavailable", timeout: 15_000,
  }, async context => {
    const directory = await mkdtemp(join(tmpdir(), "df-terminal-shell-"))
    const startupDirectory = join(directory, "startup 空格 ' quote")
    const redirectsZdotdir = startup === "redirected"
    const finalStartupDirectory = redirectsZdotdir ? join(startupDirectory, "relocated") : startupDirectory
    await mkdir(finalStartupDirectory, { recursive: true })
    const replacePath = startup === "home" ? "" : 'export PATH=/usr/bin:/bin\n'
    const files = new Map([
      [join(startupDirectory, ".zshenv"), 'export DF_STARTUP="env"\n' + (redirectsZdotdir ? 'export ZDOTDIR="$ZDOTDIR/relocated"\n' : "")],
      [join(finalStartupDirectory, ".zprofile"), 'DF_STARTUP="$DF_STARTUP>profile"\n' + replacePath],
      [join(finalStartupDirectory, ".zshrc"), 'DF_STARTUP="$DF_STARTUP>rc"\nPROMPT="deskfleet-test> "\n' + replacePath],
      [join(finalStartupDirectory, ".zlogin"), 'DF_STARTUP="$DF_STARTUP>login"\n' + replacePath],
    ])
    for (const [path, content] of files) await writeFile(path, content)
    await writeFile(join(directory, "image 空格.png"), png)
    const originalShell = process.env.SHELL
    const originalZdotdir = process.env.ZDOTDIR
    process.env.SHELL = shell!
    if (startup === "home") delete process.env.ZDOTDIR
    else process.env.ZDOTDIR = startupDirectory
    const sessions = new TerminalSessions({
      directory: join(directory, "terminals"),
      // Isolate the child shell's default startup directory without changing this process's HOME.
      factory: startup === "home" ? config => createTerminal({ ...config, env: { ...config.env, HOME: startupDirectory } }) : undefined,
    })
    context.after(async () => {
      if (originalShell === undefined) delete process.env.SHELL
      else process.env.SHELL = originalShell
      if (originalZdotdir === undefined) delete process.env.ZDOTDIR
      else process.env.ZDOTDIR = originalZdotdir
      try { await sessions.close() }
      finally { await rm(directory, { recursive: true, force: true }) }
    })

    const terminal = await sessions.dial({ mode: "create", terminalId: randomUUID(), cwd: directory, cols: 120, rows: 24 })
    await sessions.input(terminal.id, Buffer.from([
      '[[ -o login && -o interactive ]] || exit 17',
      'printf "\\nDF_STATE:%s:%s\\n" "$DF_STARTUP" "${ZDOTDIR-unset}"',
      'printf "\\nDF_PATH:%s\\n" "$PATH"',
      'icat --help || exit $?',
      'icat "image 空格.png" || exit $?',
      ...(startup === "home" ? ['"$SHELL" -c \'[[ ${+ZDOTDIR} == 0 ]] || exit 19; printf "\\nDF_CHILD:%s\\n" "$DF_STARTUP"\' || exit $?'] : []),
      'exit',
    ].join("; ") + "\r"))
    await sessions.waitForExit(terminal.id)
    const snapshot = sessions.snapshot(terminal.id)
    const output = (await sessions.read(terminal.id, 0, snapshot.end)).toString().replaceAll("\r", "")
    assert.equal(snapshot.summary.exitCode, 0, output)
    assert.ok(output.includes(`\nDF_STATE:env>profile>rc>login:${startup === "home" ? "unset" : finalStartupDirectory}\n`), output)
    const bin = join(directory, "terminals", ".shell-bin")
    const path = output.split("\n").find(line => line.startsWith("DF_PATH:"))?.slice("DF_PATH:".length).split(":")
    assert.equal(path?.[0], bin, output)
    assert.equal(path?.filter(entry => entry === bin).length, 1, output)
    if (startup !== "home") assert.deepEqual(path, [bin, "/usr/bin", "/bin"])
    else assert.ok(output.includes("\nDF_CHILD:env\n"), output)
    assert.ok(output.includes("Usage: icat [--] [FILE|-]"), output)
    assert.ok(output.includes(`;size=${png.length};inline=1;preserveAspectRatio=1:${png.toString("base64")}\x07`), output)
    for (const [path, content] of files) assert.equal(await readFile(path, "utf8"), content)
  })
}
