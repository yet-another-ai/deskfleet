/** A DeskFleet session ID is unique within a machine registration on a team. */
export interface WorkerReference {
  teamId: string
  machineId: string
  sessionId: string
}

function resourceId(value: string): string {
  if (!value || value.length > 256 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Invalid Worker ID. Copy it again from the session menu.")
  }
  return value
}

export function formatWorkerReference({ teamId, machineId, sessionId }: WorkerReference): string {
  const parts = [teamId, machineId, sessionId].map(id => encodeURIComponent(resourceId(id)))
  return `@worker[${parts.join("/")}]`
}

/** Only the text being sent addresses a Worker. History, quoted messages and files are independent. */
export function parseWorkerReference(text: string): { target: WorkerReference; text: string } | undefined {
  let target: WorkerReference | undefined
  const task = text.replace(/@worker\[([^\]\r\n]*)(\]?)/giu, (_match, path: string, close: string) => {
    const parts = path.split("/")
    if (!close || parts.length !== 3 || parts.some(part => !/^(?:[\w.!~*'()-]|%[\da-f]{2})+$/iu.test(part))) {
      throw new Error("Invalid Worker ID. Copy it again from the session menu.")
    }
    const [teamId, machineId, sessionId] = parts.map(part => resourceId(decodeURIComponent(part))) as [string, string, string]
    if (target && (target.teamId !== teamId || target.machineId !== machineId || target.sessionId !== sessionId)) {
      throw new Error("Specify one Worker per message.")
    }
    target = { teamId, machineId, sessionId }
    return ""
  })
  return target ? { target, text: task.trim() } : undefined
}
