import type { CentralApi } from "./central.ts"
import type { ScheduleInput, ScheduleRun, ScheduledTask } from "../../../apps/daemon/src/schedule-protocol.ts"

export type { ScheduleInput, ScheduleRun, ScheduledTask } from "../../../apps/daemon/src/schedule-protocol.ts"

/** Schedule management uses the same authenticated Machine scope as the other clients. */
export function schedulesClient(central: Pick<CentralApi, "rpc">, teamId: string, machineId: string) {
  return {
    list: () => central.rpc<ScheduledTask[]>(teamId, machineId, "scheduleList", {}),
    create: (schedule: ScheduleInput) => central.rpc<ScheduledTask>(teamId, machineId, "scheduleCreate", { schedule }),
    update: (scheduleId: string, changes: Partial<ScheduleInput>) => central.rpc<ScheduledTask>(teamId, machineId, "scheduleUpdate", { scheduleId, changes }),
    remove: (scheduleId: string) => central.rpc<null>(teamId, machineId, "scheduleDelete", { scheduleId }),
    run: (scheduleId: string) => central.rpc<ScheduleRun>(teamId, machineId, "scheduleRun", { scheduleId }),
  }
}
