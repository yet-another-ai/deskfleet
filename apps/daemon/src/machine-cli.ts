import { parseArgs } from "node:util"
import { DaemonClient } from "./control-client.ts"
import { centralUrl } from "./central-protocol.ts"

/** Enrollment credentials arrive on stdin, never in process arguments or shell history. */
export async function runMachineCli(command: "status" | "prepare-enrollment" | "enroll", args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { "server-url": { type: "string" }, help: { type: "boolean", short: "h" } } })
  if (values.help) {
    console.log(command === "enroll" ? "Usage: deskfleet-daemon enroll --server-url <https://backend> < machine-credentials.json" : `Usage: deskfleet-daemon ${command}`)
    return
  }
  const client = await DaemonClient.connect(() => {}, () => {})
  try {
    if (command !== "enroll") {
      console.log(JSON.stringify(await client.call(command === "status" ? "centralStatus" : "centralPrepareEnrollment", {}), null, 2))
      return
    }
    if (!values["server-url"]) throw new Error("Provide --server-url and the enrollment JSON on stdin")
    const serverUrl = centralUrl(values["server-url"])
    if (process.stdin.isTTY) console.error("Paste the machine enrollment JSON, then close stdin (Ctrl-D):")
    let input = ""
    for await (const chunk of process.stdin) {
      input += String(chunk)
      if (input.length > 32 * 1024) throw new Error("Enrollment JSON is too large")
    }
    const value = JSON.parse(input) as Record<string, unknown>
    for (const key of ["machineId", "teamId", "token"]) if (typeof value[key] !== "string" || !value[key]) throw new Error(`Missing enrollment ${key}`)
    const status = await client.call("centralEnroll", { serverUrl, machineId: value.machineId as string, teamId: value.teamId as string, token: value.token as string })
    console.log(JSON.stringify(status, null, 2))
  } finally { client.close() }
}
