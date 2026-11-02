import type { CentralApi, LocalEnrollment, LocalMachineStatus } from "@deskfleet/client/central"

export interface EnrollmentControl {
  status(): Promise<LocalMachineStatus>
  prepare(target: { serverUrl: string; teamId: string }): Promise<LocalEnrollment & { identityToken: string }>
  enroll(credentials: { serverUrl: string; machineId: string; teamId: string; token: string; originId: string }): Promise<LocalEnrollment>
}

/** A Team joins this host without replacing any other Team's execution context. */
export async function enrollLocalMachine(central: Pick<CentralApi, "status" | "enrollHeadless">, local: EnrollmentControl, teamId: string, name?: unknown): Promise<LocalEnrollment> {
  const chosen = typeof name === "string" ? name.trim() : undefined
  if (name !== undefined && chosen === undefined) throw new Error("Invalid machine name")
  const { serverUrl } = await central.status()
  const current = (await local.status()).registrations.find(value => value.serverUrl === serverUrl && value.teamId === teamId)
  if (current?.configured && !current.revoked) return current
  const prepared = await local.prepare({ serverUrl, teamId })
  const result = await central.enrollHeadless(teamId, {
    name: chosen || prepared.machineName,
    originId: prepared.identity.originId,
    localMachineId: prepared.identity.machineId,
    identityToken: prepared.identityToken,
  })
  return local.enroll({ serverUrl, machineId: result.machine.id, teamId, token: result.token, originId: prepared.identity.originId })
}
