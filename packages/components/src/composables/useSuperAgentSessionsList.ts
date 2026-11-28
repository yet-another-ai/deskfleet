import { shallowRef } from "vue"
import type { SuperAgentSession } from "@deskfleet/client/super-agent"

export function superAgentSessionKey(session: Pick<SuperAgentSession, "sessionId" | "engine" | "machineId">): string {
  return session.engine === "byoa" ? `byoa:${session.machineId ?? ""}:${session.sessionId}` : `hosted:${session.sessionId}`
}

interface ScopedSessions {
  scope: string
  sessions: SuperAgentSession[]
}

/** Lightweight shared cache so SuperAgentView and SuperAgentSection stay in sync across route changes. */
const state = shallowRef<ScopedSessions>()

export function getSharedSuperAgentSessions(scope: string): SuperAgentSession[] | undefined {
  return state.value?.scope === scope ? state.value.sessions : undefined
}

export function setSharedSuperAgentSessions(scope: string, sessions: SuperAgentSession[]): void {
  state.value = { scope, sessions }
}

export function upsertSharedSuperAgentSession(scope: string, session: SuperAgentSession): void {
  const current = state.value?.scope === scope ? state.value.sessions : []
  const key = superAgentSessionKey(session)
  const next = [session, ...current.filter(item => superAgentSessionKey(item) !== key)]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  state.value = { scope, sessions: next }
}

export function removeSharedSuperAgentSession(scope: string, key: string): void {
  if (state.value?.scope === scope) {
    state.value = { scope, sessions: state.value.sessions.filter(session => superAgentSessionKey(session) !== key) }
  }
}
