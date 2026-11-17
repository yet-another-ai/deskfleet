export interface SessionWindowTarget {
  sessionId: string
  teamId?: string
  machineId?: string
}

export function sessionWindowHash(target: SessionWindowTarget): string {
  const params = new URLSearchParams({ window: "session" })
  if (target.teamId) params.set("teamId", target.teamId)
  if (target.machineId) params.set("machineId", target.machineId)
  return `#/sessions/${encodeURIComponent(target.sessionId)}?${params.toString()}`
}

export function parseSessionWindowHash(hash: string): SessionWindowTarget | undefined {
  const [path = "", query = ""] = (hash.startsWith("#") ? hash.slice(1) : hash).split("?")
  const match = /^\/sessions\/([^/]+)$/u.exec(path)
  const params = new URLSearchParams(query)
  if (!match?.[1] || match[1] === "archived" || params.get("window") !== "session") return undefined
  try {
    const sessionId = decodeURIComponent(match[1])
    const teamId = params.get("teamId") || undefined
    const machineId = params.get("machineId") || undefined
    return { sessionId, ...(teamId ? { teamId } : {}), ...(machineId ? { machineId } : {}) }
  } catch {
    return undefined
  }
}

export function sessionWindowKey(target: SessionWindowTarget): string {
  return JSON.stringify([target.teamId ?? "", target.machineId ?? "", target.sessionId])
}

export function openSessionInNewWindow(target: SessionWindowTarget): void {
  window.open(
    `${window.location.origin}${window.location.pathname}${sessionWindowHash(target)}`,
    "_blank",
    "popup,width=1120,height=780",
  )
}
