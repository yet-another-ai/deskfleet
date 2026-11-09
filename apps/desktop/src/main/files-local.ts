import type { CentralApi, LocalMachineStatus } from "@deskfleet/client/central"
import type { FileTarget } from "@deskfleet/client/files"

/** Locality changes preview behavior; WindowFiles separately checks file access. */
export async function isLocalFileTarget(
  central: Pick<CentralApi, "status">,
  enrollment: () => Promise<LocalMachineStatus>,
  target: FileTarget,
): Promise<boolean> {
  if (target.kind === "local") return true
  try {
    const [account, status] = await Promise.all([central.status(), enrollment()])
    if (!account.user) return false
    return status.registrations.some(value => value.configured && !value.revoked
      && value.serverUrl === account.serverUrl && value.teamId === target.teamId && value.machineId === target.machineId)
  } catch {
    return false
  }
}
