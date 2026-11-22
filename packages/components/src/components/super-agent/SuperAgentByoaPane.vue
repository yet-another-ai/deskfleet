<script setup lang="ts">
import { Cpu, ExternalLink, Layers3, ListTree, LoaderCircle } from "@lucide/vue"
import { watchImmediate } from "@vueuse/core"
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { Machine } from "@deskfleet/client/central"
import type { SuperAgentByoaTarget, SuperAgentSession } from "@deskfleet/client/super-agent"
import type { AgentActor } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useConversationProjection } from "../../composables/useConversationProjection.ts"
import { useFileTarget } from "../../composables/useFileTarget.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { liveTurnStates, promotedPendingInputs } from "../../services/agent-conversation.ts"
import { createAgentUsageSelector } from "../../services/agent-usage.ts"
import { hasIncompleteAttachmentUploads, hasSubmittableText, previewPromptContent, sessionTitleFromDraft, type ComposerAttachment } from "../../services/composer-attachments.ts"
import { commandDraft, type ComposerMention } from "../../services/composer-mentions.ts"
import { buildComposerPrompt } from "../../services/composer-prompt.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore, type SessionTarget } from "../../stores/fleet.ts"
import { useProvidersStore } from "../../stores/providers.ts"
import ErrorNotice from "../common/ErrorNotice.vue"
import UiButton from "../common/UiButton.vue"
import SessionComposer from "../composer/SessionComposer.vue"
import AgentAuthStatus from "../session/AgentAuthStatus.vue"
import AgentBacklog from "../session/AgentBacklog.vue"
import AgentConversation from "../session/AgentConversation.vue"
import AgentNotice from "../session/AgentNotice.vue"
import AgentOutline from "../session/AgentOutline.vue"
import AgentPermissions from "../session/AgentPermissions.vue"
import SessionAllowance from "../session/SessionAllowance.vue"
import SessionConversationPane from "../session/SessionConversationPane.vue"
import SessionWelcome from "../session/SessionWelcome.vue"

const props = defineProps<{
  teamId: string
  machine: Machine
  sessionId?: string
  target: SuperAgentByoaTarget | null
  sessionMeta?: SuperAgentSession
  canConfigure: boolean
  hostedConfigured: boolean
  onSessionChange: (session: SuperAgentSession, selectIt?: boolean) => void
  onOpenConfig: () => void
  onSwitchToCloud: () => void
}>()

const { t } = useI18n()
const client = usePlatformClient()
const account = useAccountSession()
const fleet = useFleetStore()
const agents = useAgentSessionsStore()
const providers = useProvidersStore()
const composer = useTemplateRef<InstanceType<typeof SessionComposer>>("composer")
const selectUsage = createAgentUsageSelector()

let disposed = false
onBeforeUnmount(() => { disposed = true })

const refreshMachine = () => {
  void fleet.refreshLocal().then(() => {
    if (fleet.localDesktopTarget.online || client.agent.history) void agents.refresh()
    if (fleet.localDesktopTarget.online || client.providers.display) void providers.refresh()
  })
}
onMounted(refreshMachine)

const machineSummary = computed(() => fleet.machines[0] ?? {
  id: props.machine.id,
  name: props.machine.name,
  local: false,
  online: props.machine.online,
  desktop: false,
  workspaces: [],
  sessions: [],
  terminals: [],
})

const effectiveProviderId = computed(() => props.sessionMeta?.providerId ?? props.target?.providerId ?? "")
const effectiveProviderName = computed(() => {
  const id = effectiveProviderId.value
  const matched = providers.providers.find(item => item.id === id)?.name
  return matched ?? props.sessionMeta?.providerName ?? props.target?.providerName ?? id
})

const location = computed<SessionTarget | null>(() => {
  if (props.sessionId) {
    const found = fleet.findSession(props.sessionId)
    if (found) return found
  }
  return { machine: machineSummary.value }
})
const resourceTarget = useFileTarget(() => props.machine.id)

const view = computed(() => props.sessionId ? agents.views[props.sessionId] : undefined)
const snapshot = computed(() => view.value?.snapshot ?? null)
const projection = useConversationProjection(() => view.value?.events ?? [], snapshot)
const usage = computed(() => selectUsage(view.value?.events ?? []))
const run = computed(() => snapshot.value?.runs.at(-1))
const activeTurn = computed(() => snapshot.value?.turns.find(turn => liveTurnStates.includes(turn.state)))
const archiveState = computed(() => snapshot.value?.session.archiveState)
const active = computed(() => !archiveState.value || archiveState.value === "active")
const connected = computed(() => agents.state === "connected")
const canSteer = computed(() => !!snapshot.value?.session.capabilities?.steering && !!activeTurn.value && activeTurn.value.state !== "cancelling")
const promotedInputIds = computed(() => promotedPendingInputs(snapshot.value, view.value?.events).map(input => input.id))
const readingId = computed(() => JSON.stringify(["super-agent-byoa", props.teamId, props.machine.id, props.sessionId ?? "new"]))

const draftKey = computed(() => props.sessionId ?? `super-agent-new:${props.machine.id}`)
const draft = computed({
  get: () => agents.drafts[draftKey.value] ?? "",
  set: value => { agents.drafts[draftKey.value] = value },
})
const attachments = computed<ComposerAttachment[]>({
  get: () => agents.draftAttachments[draftKey.value] ?? [],
  set: value => { agents.draftAttachments[draftKey.value] = value },
})
const mentions = computed<ComposerMention[]>({
  get: () => agents.draftMentions[draftKey.value] ?? [],
  set: value => { agents.draftMentions[draftKey.value] = value },
})

interface PendingByoaSession {
  sessionId: string
  targetKey: string
}

const busy = ref(false)
const actionError = shallowRef<unknown>()
const pendingCreation = shallowRef<PendingByoaSession>()
const byoaDraftYolo = ref(!!props.target?.yolo)
let transitioningSessionId: string | undefined

watch(() => props.target?.yolo, value => {
  if (!props.sessionId && !pendingCreation.value) byoaDraftYolo.value = !!value
})

watchImmediate(() => props.sessionId, id => {
  const transitioning = !!id && id === transitioningSessionId
  if (!transitioning) actionError.value = undefined
  if (id) {
    pendingCreation.value = undefined
    byoaDraftYolo.value = !!props.target?.yolo
    void agents.open(id)
  }
})
watch(() => props.machine.online, online => {
  if (online && props.sessionId) void agents.open(props.sessionId)
})

const suggestions = computed(() => [
  { label: t("superAgent.plan"), prompt: t("superAgent.planPrompt"), icon: Layers3 },
  { label: t("superAgent.breakdown"), prompt: t("superAgent.breakdownPrompt"), icon: ListTree },
])

function suggest(prompt: string): void {
  draft.value = prompt
  composer.value?.focus()
}

async function runAction(operation: () => Promise<unknown>): Promise<void> {
  if (busy.value) return
  busy.value = true
  actionError.value = undefined
  try { await operation() }
  catch (reason) { actionError.value = reason }
  finally { busy.value = false }
}

async function submit(delivery: "backlog" | "steer"): Promise<void> {
  if (busy.value || hasIncompleteAttachmentUploads(attachments.value, resourceTarget.value)) return
  if (!hasSubmittableText(draft.value, attachments.value)) return
  if (!props.sessionId) {
    await createAndSubmit()
    return
  }
  const sessionId = props.sessionId
  await runAction(async () => {
    delete agents.draftErrors[sessionId]
    const currentDraft = draft.value
    const currentAttachments = attachments.value
    const currentMentions = mentions.value
    const submittedDraft = { mentions: currentMentions, attachmentIds: currentAttachments.map(item => item.id) }
    const turnId = activeTurn.value?.id
    const providerId = snapshot.value?.session.provider ?? effectiveProviderId.value
    const content = currentAttachments.length || currentMentions.length
      ? await buildComposerPrompt({
        draft: currentDraft, attachments: currentAttachments, mentions: currentMentions,
        providerId, sessionId, target: resourceTarget.value, filesApi: client.files,
        resolveReferences: agents.resolveComposerReferences,
      })
      : currentDraft
    const command = commandDraft(typeof content === "string" ? content : content.find(block => block.type === "text")?.text ?? "")
    const intent = command ? "backlog" : delivery
    await agents.submit(sessionId, content, intent, intent === "steer" ? turnId : undefined, currentDraft, submittedDraft)
    if (account && providerId) {
      const updated = await account.central.registerSuperAgentMachineSession(props.teamId, {
        machineId: props.machine.id,
        sessionId,
        providerId,
        providerName: effectiveProviderName.value || null,
        title: snapshot.value?.session.title || props.sessionMeta?.title || sessionTitleFromDraft(currentDraft, currentAttachments),
        lastActiveAt: Date.now(),
      }).catch(() => undefined)
      if (updated) props.onSessionChange(updated, false)
    }
  })
}

async function createAndSubmit(): Promise<void> {
  const providerId = props.target?.providerId
  if (!providerId || !props.machine.online) return
  const key = draftKey.value
  const text = draft.value
  const currentAttachments = attachments.value
  const currentMentions = mentions.value
  const submittedDraft = { mentions: currentMentions, attachmentIds: currentAttachments.map(item => item.id) }
  const title = sessionTitleFromDraft(text, currentAttachments)
  const cwd = props.target?.cwd ?? undefined
  const enableYolo = byoaDraftYolo.value
  const targetKey = JSON.stringify([props.machine.id, providerId, cwd ?? null])
  await runAction(async () => {
    const pending = pendingCreation.value
    const existingSession = pending?.targetKey === targetKey ? agents.sessions[pending.sessionId] : undefined
    const reusablePending = pending?.targetKey === targetKey
      && (!existingSession || (existingSession.lifecycle !== "provision_failed" && existingSession.lifecycle !== "deleting" && existingSession.archiveState === "active"))
      ? pending
      : undefined
    const id = reusablePending
      ? reusablePending.sessionId
      : (await agents.create(
        undefined, title, "directory", providerId, undefined, undefined, enableYolo,
        { deferStartup: true, superAgent: true, ...(cwd ? { cwd } : {}) },
      )).session.id
    if (!reusablePending) pendingCreation.value = { sessionId: id, targetKey }
    else if (existingSession && !!existingSession.yolo !== enableYolo) await agents.setYolo(id, enableYolo)
    agents.preparingDrafts[id] = true
    try {
      const userId = account?.account.value.user?.id
      const author: AgentActor = userId
        ? { kind: "user", userId, sourceMachine: { originId: "", id: props.machine.id } }
        : { kind: "local_token", sourceMachine: { originId: "", id: props.machine.id } }
      agents.optimisticInputs[id] = {
        id: "optimistic",
        sessionId: id,
        submissionCommandId: "",
        author,
        content: previewPromptContent(text, currentAttachments),
        acceptedSeq: "0",
        state: "pending",
        requestedDelivery: "backlog",
        createdAt: new Date().toISOString(),
      }
      const registered: SuperAgentSession = account
        ? await account.central.registerSuperAgentMachineSession(props.teamId, {
          machineId: props.machine.id,
          sessionId: id,
          providerId,
          providerName: effectiveProviderName.value || null,
          title,
          lastActiveAt: Date.now(),
        })
        : {
          sessionId: id, title, lastActiveAt: Date.now(), engine: "byoa",
          machineId: props.machine.id, machineName: props.machine.name,
          providerId, providerName: effectiveProviderName.value || null,
        }
      if (pendingCreation.value?.sessionId === id) pendingCreation.value = undefined
      if (!disposed) {
        agents.drafts[id] = text
        if (currentAttachments.length) agents.draftAttachments[id] = currentAttachments
        if (currentMentions.length) agents.draftMentions[id] = currentMentions
        delete agents.drafts[key]
        delete agents.draftAttachments[key]
        delete agents.draftMentions[key]
        byoaDraftYolo.value = !!props.target?.yolo
        transitioningSessionId = id
        props.onSessionChange(registered, true)
      }
      const content = currentAttachments.length || currentMentions.length
        ? await buildComposerPrompt({
          draft: text, attachments: currentAttachments, mentions: currentMentions,
          providerId, sessionId: id, target: resourceTarget.value, filesApi: client.files,
          resolveReferences: agents.resolveComposerReferences,
        })
        : text
      await agents.submit(id, content, "backlog", undefined, text, submittedDraft)
      if (!disposed) {
        if (agents.drafts[id] === text) delete agents.drafts[id]
        if (agents.draftAttachments[id] === currentAttachments) delete agents.draftAttachments[id]
        if (agents.draftMentions[id] === currentMentions) delete agents.draftMentions[id]
      }
    } finally {
      delete agents.preparingDrafts[id]
      delete agents.optimisticInputs[id]
      if (transitioningSessionId === id) {
        await nextTick()
        if (transitioningSessionId === id) transitioningSessionId = undefined
      }
    }
  })
}

const contextLabel = computed(() => t("superAgent.byoaRunningOn", { machine: props.machine.name, provider: effectiveProviderName.value }))

const composerDisabled = computed(() => {
  if (!props.machine.online) return true
  if (props.sessionId) {
    return !connected.value || !!view.value?.syncing || !!view.value?.error || snapshot.value?.session.lifecycle !== "ready"
  }
  return !props.target?.providerId
})
</script>

<template>
  <SessionConversationPane
    :reading-id="readingId"
    :session-id="sessionId"
    :loading="!!sessionId && !!view?.loading"
    :ready="!sessionId || !!snapshot"
    :revision="projection"
    :sidebar="!!account?.machine.value"
    show-composer
    :composer-active="active"
  >
    <template #default="{ focusedEntry }">
      <p v-if="sessionId && view?.loading" class="m-auto flex items-center gap-2 text-sm text-ui-text-muted" role="status">
        <LoaderCircle :size="16" :stroke-width="2" class="animate-spin" aria-hidden="true" />{{ t("agent.loading") }}
      </p>
      <template v-else-if="sessionId && snapshot">
        <AgentConversation
          :events="view!.events"
          :snapshot="snapshot"
          :projection="projection"
          :optimistic-input="agents.optimisticInputs[sessionId]"
          :resource-target="resourceTarget"
          :notices="agents.notices[sessionId]"
          :disabled="!active || !connected || busy || !!view?.syncing || !!view?.error"
          :locate-entry="focusedEntry"
          @dismiss-notice="agents.dismissNotice(sessionId, $event)"
        >
          <template #live><AgentAuthStatus v-if="agents.authStatuses[sessionId]" :status="agents.authStatuses[sessionId]!" /></template>
        </AgentConversation>
      </template>
      <SessionWelcome v-else-if="!sessionId" :heading="t('superAgent.heading')">
        <p class="m-0 text-center text-sm text-ui-text-muted">{{ contextLabel }}</p>
        <div v-if="!composerDisabled" class="mt-3 flex flex-wrap justify-center gap-2">
          <UiButton v-for="item in suggestions" :key="item.label" variant="ghost" @click="suggest(item.prompt)">
            <component :is="item.icon" :size="15" class="text-ui-accent" aria-hidden="true" />{{ item.label }}
          </UiButton>
        </div>
      </SessionWelcome>
    </template>

    <template #outline="{ activeEntry, locateEntry }">
      <AgentOutline v-if="sessionId && snapshot" :events="view!.events" :snapshot="snapshot" :projection="projection" :active="activeEntry" class="absolute left-1 top-1/2 z-20 max-h-[calc(100%-2rem)] -translate-y-1/2" @select="locateEntry" />
    </template>

    <template #notices>
      <AgentNotice v-if="!machine.online" tone="warning" :text="t('superAgent.byoaMachineOffline', { machine: machine.name })">
        <UiButton v-if="canConfigure" size="sm" @click="onOpenConfig">{{ t("superAgent.configure") }}</UiButton>
        <UiButton v-if="canConfigure && hostedConfigured" size="sm" @click="onSwitchToCloud">{{ t("superAgent.switchToCloud") }}</UiButton>
      </AgentNotice>
      <ErrorNotice v-if="actionError" :error="actionError" />
      <ErrorNotice v-if="sessionId && !view?.loading && machine.online && (!connected || view?.error)" :title="t('agent.disconnected')" :error="view?.error || agents.error" :relay-denied-reason="view?.error ? view.relayDeniedReason : agents.error ? agents.relayDeniedReason : undefined">
        <UiButton type="button" size="sm" :disabled="agents.state === 'connecting'" @click="runAction(() => agents.open(sessionId!))">{{ t("agent.reconnect") }}</UiButton>
      </ErrorNotice>
      <template v-if="sessionId && snapshot">
        <AgentNotice v-if="!active" :text="t(archiveState === 'archived' ? 'agent.archived' : 'agent.archiving')">
          <UiButton v-if="archiveState === 'archived'" size="sm" type="button" :disabled="!machine.online || busy" @click="runAction(() => agents.restore(sessionId!))">{{ t("agent.restore") }}</UiButton>
        </AgentNotice>
        <ErrorNotice v-if="snapshot.session.error" :error="snapshot.session.error" />
        <AgentNotice v-if="run?.state === 'stopping'" tone="progress" :text="t(`agent.runState.${run.state}`)" />
        <AgentPermissions :permissions="snapshot.permissions" :disabled="!active || !connected || busy || !!view?.syncing || !!view?.error" @respond="(id, option) => runAction(() => agents.respond(sessionId!, id, option))" />
        <SessionAllowance :snapshot="snapshot" />
        <AgentBacklog :inputs="snapshot.inputs" :exclude-input-ids="promotedInputIds" :can-steer="canSteer" :disabled="!active || !connected || busy || !!view?.syncing || !!view?.error" @steer="id => runAction(() => agents.steer(sessionId!, id, activeTurn!.id))" @withdraw="id => runAction(() => agents.withdraw(sessionId!, id))" @retry="id => runAction(() => agents.retry(sessionId!, id))" />
      </template>
    </template>

    <template #composer>
      <SessionComposer
        v-if="active"
        ref="composer"
        v-model="draft"
        v-model:attachments="attachments"
        v-model:mentions="mentions"
        v-model:draft-yolo="byoaDraftYolo"
        :location="location"
        :usage="sessionId ? usage : undefined"
        :disabled="composerDisabled"
        :submitting="busy || (!!sessionId && !!agents.preparingDrafts[sessionId])"
        :active-turn="!!activeTurn"
        :can-steer="canSteer"
        :can-cancel="!!sessionId && !!activeTurn && activeTurn.state !== 'cancelling' && connected && !busy && !view?.syncing && !view?.error"
        @submit="submit"
        @cancel="sessionId && activeTurn && runAction(() => agents.cancel(sessionId!, activeTurn!.id))"
      >
        <template #context>
          <div class="flex min-w-0 items-center gap-2 text-xs text-ui-text-muted">
            <Cpu :size="14" class="shrink-0 text-ui-accent" aria-hidden="true" />
            <span class="truncate">{{ contextLabel }}</span>
            <button
              v-if="sessionId"
              type="button"
              class="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ui-text-muted ui-motion hover:bg-ui-hover hover:text-ui-text"
              @click="account?.openSession(machine.id, sessionId)"
            >
              <ExternalLink :size="12" aria-hidden="true" />{{ t("superAgent.openInSession") }}
            </button>
          </div>
        </template>
      </SessionComposer>
    </template>
  </SessionConversationPane>
</template>
