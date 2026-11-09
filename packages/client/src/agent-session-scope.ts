import type { AgentEvent } from "../../../apps/daemon/src/agent-protocol.ts"
type SessionNotification = Extract<AgentEvent["payload"], { update: unknown }>

/** The daemon labels known descendants so root-only projections also work on paged history. */
export function isSubagentNotification(notification: { _meta?: SessionNotification["_meta"] }): boolean {
  const meta = notification._meta?.deskfleet
  return typeof meta === "object" && meta !== null && "subagent" in meta && meta.subagent === true
}

export function subagentNotification(notification: SessionNotification): SessionNotification
export function subagentNotification<T extends { _meta?: SessionNotification["_meta"] }>(notification: T): T
export function subagentNotification<T extends { _meta?: SessionNotification["_meta"] }>(notification: T): T {
  const meta = notification._meta?.deskfleet
  return { ...notification, _meta: { ...notification._meta, deskfleet: {
    ...(typeof meta === "object" && meta !== null && !Array.isArray(meta) ? meta : {}), subagent: true,
  } } }
}
