import { computed, shallowRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentConfiguration } from "@deskfleet/client/agent-configuration"
import { superWorkerCommandTarget, type SuperSnapshot, type SuperWorkerCommandTarget } from "../../../../apps/daemon/src/super-agent-protocol.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useProvidersStore } from "../stores/providers.ts"
import type { ComposerSkillReference } from "../services/composer-mentions.ts"
import type { ComposerReferenceScope } from "../../../../apps/daemon/src/composer-reference-protocol.ts"

export interface WorkspaceCommandMenu {
  key: string
  configuration: AgentConfiguration | null
  supportsMentions: boolean
  referenceScope?: ComposerReferenceScope
  discover(): Promise<void>
  select(kind: "command" | "skill", name: string): void
}

/** Open the existing worker's command catalog, or probe the agent that would start the next worker. */
export function useWorkspaceCommands(snapshot: Ref<SuperSnapshot | undefined>, replyTo: () => string | undefined, select: (kind: "command" | "skill", name: string, target: SuperWorkerCommandTarget) => void) {
  const { t } = useI18n()
  const agents = useAgentSessionsStore()
  const providers = useProvidersStore()
  const target = computed(() => snapshot.value && superWorkerCommandTarget(snapshot.value, replyTo()))
  const selection = computed(() => target.value && !target.value.sessionId && target.value.provider === snapshot.value?.provider ? snapshot.value.workerSelection : undefined)
  const key = computed(() => JSON.stringify([snapshot.value?.workspaceId, snapshot.value?.supportsWorkerCommands, snapshot.value?.supportsComposerMentions,
    target.value, target.value?.sessionId && (agents.sessions[target.value.sessionId]?.provider ?? target.value.provider), selection.value, providers.revision]))
  const read = shallowRef<{ key: string; value: AgentConfiguration }>()
  let fetching: { key: string; result: Promise<AgentConfiguration> } | undefined
  const configuration = computed(() => {
    if (read.value?.key !== key.value) return null
    const sessionId = target.value?.sessionId
    return sessionId && agents.configurations[sessionId] || read.value.value
  })
  async function discover(): Promise<void> {
    const current = target.value
    if (!snapshot.value?.supportsWorkerCommands) throw new Error(t("superAgent.commands.updateHost"))
    if (!current?.provider) throw new Error(t("superAgent.commands.noWorker"))
    if (configuration.value?.commands !== undefined) return
    const issued = key.value
    if (fetching?.key !== issued) {
      const result = current.sessionId ? agents.sessionConfiguration(current.sessionId, true)
        : agents.agentConfiguration({ provider: current.provider, workspaceId: snapshot.value.workspaceId ?? undefined,
          ...selection.value, composer: true, cache: true, includeMatrix: false })
      fetching = { key: issued, result }
    }
    const request = fetching
    try {
      const value = await request.result
      if (issued !== key.value) throw new Error(t("superAgent.commands.targetChanged"))
      read.value = { key: issued, value }
    } finally { if (fetching === request) fetching = undefined }
  }
  function owner(name?: string, skills: ComposerSkillReference[] = []) {
    const catalog = configuration.value
    if (!target.value || !catalog) return
    if (skills.some(skill => skill.providerId !== catalog.provider.id || !catalog.skills?.some(item => item.id === skill.id && item.invocation === skill.invocation))) {
      throw new Error(t("superAgent.commands.skillChanged"))
    }
    if (!name || catalog.commands?.some(item => item.name === name)) return { ...target.value, provider: catalog.provider.id }
  }
  const menu = computed<WorkspaceCommandMenu>(() => ({
    key: key.value, configuration: configuration.value, discover, supportsMentions: !!snapshot.value?.supportsComposerMentions,
    referenceScope: snapshot.value?.workspaceId ? { workspaceId: snapshot.value.workspaceId }
      : target.value?.sessionId ? { sessionId: target.value.sessionId } : undefined,
    select(kind, name) { const current = owner(kind === "command" ? name : undefined); if (current) select(kind, name, current) },
  }))
  return { discover, owner, menu }
}
