export type DaemonStatusResult =
  | { ok: true; name: string; serverUrl: string; teamId: string; originId: string; localMachineId: string; identityToken: string }
  | { ok: false; reason: "invalid" | "enrolled" | "revoked" }

/** Reads a Team-specific enrollment bundle produced by prepare-enrollment. */
export function parseDaemonStatus(text: string): DaemonStatusResult {
  let value: unknown
  try { value = JSON.parse(text) } catch { return { ok: false, reason: "invalid" } }
  if (!value || typeof value !== "object") return { ok: false, reason: "invalid" }
  const status = value as { configured?: unknown; revoked?: unknown; serverUrl?: unknown; teamId?: unknown; identityToken?: unknown; machineName?: unknown; identity?: { originId?: unknown; machineId?: unknown } }
  const originId = status.identity?.originId
  const localMachineId = status.identity?.machineId
  if (typeof originId !== "string" || !originId || typeof localMachineId !== "string" || !/^\d+$/u.test(localMachineId)
    || typeof status.identityToken !== "string" || !status.identityToken || typeof status.serverUrl !== "string" || !status.serverUrl
    || typeof status.teamId !== "string" || !status.teamId) return { ok: false, reason: "invalid" }
  if (status.configured === true && status.revoked !== true) return { ok: false, reason: "enrolled" }
  return { ok: true, name: typeof status.machineName === "string" ? status.machineName : "", originId, localMachineId,
    serverUrl: status.serverUrl, teamId: status.teamId, identityToken: status.identityToken }
}
