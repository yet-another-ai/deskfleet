import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { app } from "electron"
import { createTerminal } from "../../../../crates/node/index.ts"

// Chromium's FD ownership checks are enabled in its browser main process.
// A Node-hosted daemon or ELECTRON_RUN_AS_NODE cannot reproduce this failure.
void app.whenReady().then(async () => {
  assert.equal(process.type, "browser")
  const config = { cwd: import.meta.dirname, cols: 80, rows: 24 }
  const terminal = await createTerminal({
    ...config,
    command: "/bin/sh",
    args: ["-c", "printf 'native-pty-ready\\n'; read -r value; printf 'native-pty:%s\\n' \"$value\"; exit 7"],
  })
  try {
    const chunks: Buffer[] = []
    let inputSent = false
    let exitCode: number | undefined
    for (;;) {
      const event = await terminal.nextEvent()
      if (!event) break
      if (event.kind === "error") throw new Error(event.error)
      if (event.data) chunks.push(event.data)
      if (!inputSent && Buffer.concat(chunks).includes("native-pty-ready")) {
        await terminal.write(Buffer.from("input-ok\n"))
        inputSent = true
      }
      if (event.kind === "exit") { exitCode = event.exitCode; break }
    }
    const output = Buffer.concat(chunks).toString("utf8")
    assert.doesNotMatch(output, /FD ownership violation/u)
    assert.equal(exitCode, 7, output)
    assert.match(output, /native-pty:input-ok\r?\n/u)
  } finally { await terminal.close() }

  // An executable with a missing interpreter passes command resolution and
  // fails in exec after pre_exec. The child's error pipe must remain open until
  // exec so the parent rejects the spawn instead of reporting a started PTY.
  const invalidProgram = join(import.meta.dirname, "invalid-interpreter")
  await writeFile(invalidProgram, `#!${join(import.meta.dirname, "missing-interpreter")}\n`, { mode: 0o700 })
  await assert.rejects(createTerminal({ ...config, command: invalidProgram }), /No such file|not found/iu)
  await assert.rejects(createTerminal({ ...config, command: join(import.meta.dirname, "missing-program") }), /No such file|not found/iu)
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
