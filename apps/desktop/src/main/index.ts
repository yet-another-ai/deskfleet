import { isMainThread, workerData } from "node:worker_threads"
import { CODEX_ACP_HOST_ARGUMENT, DAEMON_HOST_ARGUMENT } from "../shared/daemon-launch.ts"

// Await routing before Electron becomes ready: the daemon sets its own data
// directory and must never acquire the client's single-instance lock.
if (!isMainThread && workerData === CODEX_ACP_HOST_ARGUMENT) {
  const { runCodexAcpHost } = await import("@deskfleet/daemon/codex-acp-host")
  await runCodexAcpHost()
} else if (process.argv.includes(CODEX_ACP_HOST_ARGUMENT)) {
  const { startCodexAcpHost } = await import("./codex-acp-host.ts")
  void startCodexAcpHost(import.meta.filename)
} else if (process.argv.includes(DAEMON_HOST_ARGUMENT)) {
  const { startDaemonHost } = await import("./daemon-host.ts")
  startDaemonHost()
} else {
  await import("./client.ts")
}
