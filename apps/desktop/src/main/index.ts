import { fileURLToPath } from "node:url"
import { CODEX_ACP_ARGUMENT, configureCodexAdapterHost, runCodexAdapter } from "@deskfleet/daemon/codex"

// Await routing before Electron becomes ready: the adapter runs in Electron's
// Node mode and must never acquire the client's single-instance lock.
if (process.argv.includes(CODEX_ACP_ARGUMENT)) {
  await runCodexAdapter()
} else {
  // The daemon hosted by this app starts Codex through the same executable.
  configureCodexAdapterHost({
    command: process.execPath,
    args: [fileURLToPath(import.meta.url), CODEX_ACP_ARGUMENT],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  })
  await import("./client.ts")
}
