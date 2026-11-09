/**
 * Timeline for the cross-machine animation, in seconds within one loop. Each
 * tool call sends a request from the agent's machine through the Team server
 * to the target machine, then returns its result the same way.
 */
import { clamp, easeInOut } from "./home-motion.ts"

export type RelayStepKey = "machines" | "upload" | "open" | "capture"

export interface RelayStep {
  key: RelayStepKey
  tool: string
  start: number
  out: [number, number]
  back: [number, number]
}

export const relayLoop = 18
/** The frame shown to readers who prefer reduced motion: every step complete. */
export const relayRestTime = 14

export const relaySteps: RelayStep[] = [
  { key: "machines", tool: "deskfleet_remote_machines", start: 1.6, out: [1.6, 2.3], back: [2.3, 3.0] },
  { key: "upload", tool: "deskfleet_remote_file_upload", start: 3.5, out: [3.5, 5.2], back: [5.3, 5.9] },
  { key: "open", tool: "deskfleet_remote_mcp_call · auv", start: 6.4, out: [6.4, 7.1], back: [8.6, 9.3] },
  { key: "capture", tool: "deskfleet_remote_mcp_call · auv", start: 9.8, out: [9.8, 10.5], back: [10.8, 11.8] },
]

export const relayMoments = {
  fadeIn: [0.5, 0.8] as [number, number],
  prompt: 0.6,
  fileArrives: 5.0,
  cursorMove: [7.1, 8.1] as [number, number],
  doubleClick: 8.15,
  installerOpens: 8.4,
  flash: 10.6,
  reply: 12.4,
  fadeOut: 17.2,
}

const cursorRest = { x: 72, y: 70 }
const cursorTarget = { x: 15, y: 20 }

export const progress = (time: number, [from, to]: [number, number]): number =>
  clamp((time - from) / (to - from))

export function cursorAt(time: number): { x: number; y: number } {
  const p = easeInOut(progress(time, relayMoments.cursorMove))
  return {
    x: cursorRest.x + (cursorTarget.x - cursorRest.x) * p,
    y: cursorRest.y + (cursorTarget.y - cursorRest.y) * p,
  }
}

export interface RelayPacket {
  key: string
  /** Position along the lane from the agent's machine (0) to the target (1). */
  at: number
  direction: "out" | "back"
  kind: RelayStepKey
}

export function packetsAt(time: number): RelayPacket[] {
  const packets: RelayPacket[] = []
  for (const step of relaySteps) {
    for (const direction of ["out", "back"] as const) {
      const span = step[direction]
      if (time < span[0] || time > span[1]) continue
      const p = easeInOut(progress(time, span))
      packets.push({ key: `${step.key}-${direction}`, at: direction === "out" ? p : 1 - p, direction, kind: step.key })
    }
  }
  return packets
}

export type RelayStepState = "hidden" | "running" | "done"

export function stepState(time: number, step: RelayStep): RelayStepState {
  if (time < step.start) return "hidden"
  return time < step.back[1] ? "running" : "done"
}
