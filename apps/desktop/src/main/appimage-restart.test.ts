import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test, vi } from "vitest"

test.skipIf(process.platform !== "linux")("AppImage restart waits for the old process and keeps the new launcher's parent alive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-appimage-restart-"))
  const destination = join(directory, "Desk Fleet '$updated.AppImage")
  const target = join(directory, "replacement.cjs")
  const marker = join(directory, "started.json")
  const stop = join(directory, "stop")
  const args = ["--user-data-dir=/tmp/profile with spaces", "$(touch unwanted)", "quote'\";value"]
  let old: ChildProcess | undefined
  let supervisorPid: number | undefined
  let replacementPid: number | undefined
  try {
    await symlink(process.execPath, destination)
    await writeFile(target, `
      const fs = require('node:fs');
      let oldAlive = true;
      try { process.kill(Number(process.env.OLD_PID), 0); }
      catch (error) { if (error.code === 'ESRCH') oldAlive = false; else throw error; }
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({
        oldAlive, pid: process.pid, ppid: process.ppid, args: process.argv.slice(2),
        env: process.env.DESKFLEET_RESTART_TEST,
      }));
      const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(stop)})) clearInterval(timer); }, 20);
      setTimeout(() => clearInterval(timer), 5000).unref();
    `)
    const helper = pathToFileURL(join(import.meta.dirname, "appimage-restart.ts")).href
    old = spawn(process.execPath, ["--input-type=module", "-e", `
      import { startAppImageRestart } from ${JSON.stringify(helper)};
      process.on('message', () => process.exit(0));
      await startAppImageRestart(${JSON.stringify(destination)}, ${JSON.stringify([target, ...args])}, {
        ...process.env, OLD_PID: String(process.pid), DESKFLEET_RESTART_TEST: 'preserved',
      });
      process.send('ready');
    `], { stdio: ["ignore", "pipe", "pipe", "ipc"] })
    const exited = once(old, "exit")
    await once(old, "message")
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(existsSync(marker)).toBe(false)
    old.send("quit")
    expect(await exited).toEqual([0, null])
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true))
    const result = JSON.parse(await readFile(marker, "utf8"))
    supervisorPid = result.ppid
    replacementPid = result.pid
    expect(result).toMatchObject({ oldAlive: false, args, env: "preserved" })
    expect(supervisorPid).toBeGreaterThan(1)
    expect(supervisorPid).not.toBe(old.pid)
    expect((await readFile(`/proc/${supervisorPid}/comm`, "utf8")).trim()).toMatch(/sh$/)
    expect(() => process.kill(supervisorPid!, 0)).not.toThrow()
    await writeFile(stop, "")
    await vi.waitFor(() => {
      // An orphan can briefly remain as a zombie until the system reaps it.
      const status = `/proc/${supervisorPid}/stat`
      if (existsSync(status)) return readFile(status, "utf8").then(value => expect(value).toMatch(/\) Z /))
    })
  } finally {
    old?.kill()
    for (const pid of [replacementPid, supervisorPid]) {
      if (pid) {
        try { process.kill(pid, "SIGTERM") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error }
      }
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)
