export type BatteryState = "unknown" | "charging" | "discharging" | "empty" | "full" | "paused"

/** Aggregated battery charge and state for the machine. */
export interface BatteryStatus {
  percent: number
  state: BatteryState
}

/** Native measurements, mirrored from the Rust napi boundary (see the daemon's native-contracts.ts). */
export interface NativeSystemStatus {
  sampledAt: number
  cpuUsagePercent: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  swapUsedBytes: number
  swapTotalBytes: number
  cpuModel: string
  logicalCpuCount: number
  os: string
  arch: string
  uptimeSeconds: number
  battery?: BatteryStatus
}

/** Measurements and installed daemon information from the selected machine. */
export interface SystemStatus extends NativeSystemStatus {
  daemonVersion: string
}

export interface SystemMethods {
  systemStatus: { params: Record<string, never>; result: SystemStatus }
}
