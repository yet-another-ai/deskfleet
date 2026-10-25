import type { CentralApi, LocalEnrollment } from "@deskfleet/client/central"

export interface EnrollmentControl {
  status(): Promise<LocalEnrollment>
  prepare(): Promise<LocalEnrollment>
  enroll(credentials: { serverUrl: string; machineId: string; teamId: string; token: string }): Promise<LocalEnrollment>
}

/**
 * The daemon prepares a new identity before the server can register a revoked machine again.
 * The Team name for the machine defaults to its hostname.
 */
export async function enrollLocalMachine(central: Pick<CentralApi, "status" | "enrollHeadless">, local: EnrollmentControl, teamId: string, name?: unknown): Promise<LocalEnrollment> {
  // The renderer supplies the name across IPC; the server validates its content.
  const chosen = typeof name === "string" ? name.trim() : undefined
  if (name !== undefined && chosen === undefined) throw new Error("Invalid machine name")
  const current = await local.status()
  if (current.configured && !current.revoked) throw new Error("This machine is already enrolled")
  const prepared = current.revoked ? await local.prepare() : current
  const { serverUrl } = await central.status()
  const result = await central.enrollHeadless(teamId, {
    name: chosen || prepared.machineName,
    originId: prepared.identity.originId,
    localMachineId: prepared.identity.machineId,
  })
  return local.enroll({ serverUrl, machineId: result.machine.id, teamId, token: result.token })
}
