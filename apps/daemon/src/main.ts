import { isSea } from "node:sea"
import { parseArgs } from "node:util"
import { nativeInfo } from "@deskfleet/native"
import { startDaemon } from "./daemon.ts"
import { daemonControlDirectory } from "./control-discovery.ts"
import { runAgent } from "./agent-cli.ts"
import { CODEX_ACP_ARGUMENT, configureCodexAdapterHost, runCodexAdapter } from "./agents/codex.ts"

configureCodexAdapterHost({
  command: process.execPath,
  args: isSea() ? [CODEX_ACP_ARGUMENT] : [process.argv[1]!, CODEX_ACP_ARGUMENT],
})

function fail(error: unknown) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

async function main() {
  if (process.argv[2] === CODEX_ACP_ARGUMENT) {
    await runCodexAdapter()
    return
  }
  if (process.argv[2] === "agent") {
    await runAgent(process.argv.slice(3))
    return
  }
  const { values } = parseArgs({
    options: {
      info: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      port: { type: "string", default: "0" },
    },
  })
  if (values.help) {
    console.log("Usage: deskfleet-daemon [--port <0-65535>] [--info] [--help]")
    console.log("       deskfleet-daemon agent codex --help")
    return
  }
  if (values.info) {
    console.log(JSON.stringify({
      native: nativeInfo(),
      runtime: { node: process.versions.node, sea: isSea() },
    }))
    return
  }
  const port = Number(values.port)
  if (!/^\d+$/.test(values.port) || port > 65535) {
    throw new Error("--port must be an integer from 0 to 65535")
  }

  const daemon = await startDaemon(port, { controlDirectory: daemonControlDirectory() })
  const shutdown = () => { void daemon.close() }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
  console.log(JSON.stringify({ event: "ready", address: daemon.address }))
  try {
    await daemon.closed
  } finally {
    process.off("SIGINT", shutdown)
    process.off("SIGTERM", shutdown)
  }
}

void main().catch(fail)
