export type DaemonStatusResult =
  | { ok: true; name: string; originId: string; localMachineId: string }
  | { ok: false; reason: "invalid" | "enrolled" | "revoked" }

/**
 * Reads the JSON printed by `deskfleet-daemon status` or `prepare-enrollment`.
 * An active registration cannot be replaced, and a removed one needs a fresh identity first.
 */
export function parseDaemonStatus(text: string): DaemonStatusResult {
  let value: unknown
  try { value = JSON.parse(text) } catch { return { ok: false, reason: "invalid" } }
  if (!value || typeof value !== "object") return { ok: false, reason: "invalid" }
  const status = value as { configured?: unknown; revoked?: unknown; machineName?: unknown; identity?: { originId?: unknown; machineId?: unknown } }
  const originId = status.identity?.originId
  const localMachineId = status.identity?.machineId
  if (typeof originId !== "string" || !originId || typeof localMachineId !== "string" || !/^\d+$/u.test(localMachineId)) return { ok: false, reason: "invalid" }
  if (status.revoked === true) return { ok: false, reason: "revoked" }
  if (status.configured === true) return { ok: false, reason: "enrolled" }
  return { ok: true, name: typeof status.machineName === "string" ? status.machineName : "", originId, localMachineId }
}
