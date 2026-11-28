import type { CentralApi } from "./central.ts"
import type { ScheduleInput, ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"

export type { ScheduleInput, ScheduleRun, ScheduledTask } from "@deskfleet/protocol/schedule"

/** Schedule management uses the same authenticated Machine scope as the other clients. */
export function schedulesClient(central: Pick<CentralApi, "rpc">, teamId: string, machineId: string) {
  return {
    list: () => central.rpc<ScheduledTask[]>(teamId, machineId, "scheduleList", {}),
    create: (schedule: ScheduleInput, options?: { operationId?: string; scheduleId?: string }) =>
      central.rpc<ScheduledTask>(teamId, machineId, "scheduleCreate", {
        schedule,
        ...(options?.operationId ? { operationId: options.operationId } : {}),
        ...(options?.scheduleId ? { scheduleId: options.scheduleId } : {}),
      }),
    update: (scheduleId: string, changes: Partial<ScheduleInput>, options?: { operationId?: string }) =>
      central.rpc<ScheduledTask>(teamId, machineId, "scheduleUpdate", {
        scheduleId, changes, ...(options?.operationId ? { operationId: options.operationId } : {}),
      }),
    remove: (scheduleId: string, options?: { operationId?: string }) =>
      central.rpc<null>(teamId, machineId, "scheduleDelete", {
        scheduleId, ...(options?.operationId ? { operationId: options.operationId } : {}),
      }),
    run: (scheduleId: string, options?: { operationId?: string }) =>
      central.rpc<ScheduleRun>(teamId, machineId, "scheduleRun", {
        scheduleId, ...(options?.operationId ? { operationId: options.operationId } : {}),
      }),
  }
}
