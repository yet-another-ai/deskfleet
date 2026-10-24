import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { app } from "electron"
import { daemonControlDirectory } from "@deskfleet/daemon/control-discovery"
import { CODEX_ACP_HOST_ARGUMENT } from "../shared/daemon-launch.ts"

/** ACP runs in an ordinary Electron child, including packages with RunAsNode disabled. */
export async function startCodexAcpHost(entryPath: string): Promise<void> {
  try {
    const directory = join(daemonControlDirectory(), "electron-acp-profile")
    mkdirSync(directory, { recursive: true })
    app.setPath("userData", directory)
    app.setPath("sessionData", directory)
    if (process.platform === "darwin") app.setActivationPolicy("prohibited")
    app.on("window-all-closed", () => {})

    await app.whenReady()
    // The worker's Node event loop drains only after the adapter has stopped its
    // Codex subprocess. Electron's own loop would keep this host alive forever.
    const worker = new Worker(entryPath, {
      workerData: CODEX_ACP_HOST_ARGUMENT,
      stdin: true,
      stdout: true,
      stderr: true,
    })
    process.stdin.pipe(worker.stdin!)
    worker.stdout!.pipe(process.stdout, { end: false })
    worker.stderr!.pipe(process.stderr, { end: false })
    worker.once("error", error => console.error(error))
    worker.once("exit", code => app.exit(code))
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
}
