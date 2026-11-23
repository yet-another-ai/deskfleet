<script setup lang="ts">
import { vNavigationMotion } from "../directives/navigation-motion.ts"
import { useNavigationMotion } from "../composables/useNavigationMotion.ts"
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import UiButton from "../components/common/UiButton.vue"
import ErrorNotice from "../components/common/ErrorNotice.vue"
import { LoaderCircle, SquareTerminal } from "@lucide/vue"
import { storeToRefs } from "pinia"
import { watchImmediate } from "@vueuse/core"
import { computed, defineAsyncComponent, inject, onScopeDispose, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import type { AgentSessionContext, AgentSnapshot } from "@deskfleet/protocol/agent"
import SessionHeader from "../components/session/SessionHeader.vue"
import SessionConversationPane from "../components/session/SessionConversationPane.vue"
import ResourcePath from "../components/chrome/ResourcePath.vue"
import { newTerminalWindowKey, windowHeaderActionsTargetKey } from "../components/chrome/windowHeaderActions.ts"
import OpenWithMenu from "../components/catalog/OpenWithMenu.vue"
import SessionComposer from "../components/composer/SessionComposer.vue"
import SessionAllowance from "../components/session/SessionAllowance.vue"
import AgentBacklog from "../components/session/AgentBacklog.vue"
import AgentConversation from "../components/session/AgentConversation.vue"
import AgentAuthStatus from "../components/session/AgentAuthStatus.vue"
import AgentNotice from "../components/session/AgentNotice.vue"
import AgentOutline from "../components/session/AgentOutline.vue"
import AgentPermissions from "../components/session/AgentPermissions.vue"
import AgentSessionMenu from "../components/session/AgentSessionMenu.vue"
import RenameSessionDialog from "../components/session/RenameSessionDialog.vue"
import ForkSessionDialog from "../components/session/ForkSessionDialog.vue"
import { useFleetStore } from "../stores/fleet.ts"
import { useLayoutStore } from "../stores/layout.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useTerminalsStore } from "../stores/terminals.ts"
import { openSessionInNewWindow } from "@deskfleet/client/session-window"
import { useConnectionResume } from "../composables/useConnectionResume.ts"
import { useAccountSession } from "../composables/useAccountSession.ts"
import { useFileTarget } from "../composables/useFileTarget.ts"
import { useSessionLabel } from "../composables/useSessionLabel.ts"
import { useSessionRead } from "../composables/useSessionRead.ts"
import { useSessionFaces } from "../composables/useSessionFaces.ts"
import UserAvatarStack from "../components/common/UserAvatarStack.vue"
import { liveTurnStates, promotedPendingInputs } from "../services/agent-conversation.ts"
import { useConversationProjection } from "../composables/useConversationProjection.ts"
import { createAgentUsageSelector } from "../services/agent-usage.ts"
import { hasIncompleteAttachmentUploads } from "../services/composer-attachments.ts"
import { buildComposerPrompt } from "../services/composer-prompt.ts"
import { commandDraft } from "../services/composer-mentions.ts"

const client = usePlatformClient()

// xterm stays out of the session bundle until the panel is opened.
const SessionTerminalPanel = defineAsyncComponent(() => import("../components/terminal/SessionTerminalPanel.vue"))
const props = defineProps<{ sessionId: string }>()
const { t } = useI18n()
const motion = useNavigationMotion()
const router = useRouter()
const newTerminalWindow = inject(newTerminalWindowKey, undefined)
const windowedMainWindow = !!inject(windowHeaderActionsTargetKey)
let disposed = false
onScopeDispose(() => { disposed = true })
const sessionLabel = useSessionLabel()
const account = useAccountSession()
const fleet = useFleetStore()
const agents = useAgentSessionsStore()
const terminals = useTerminalsStore()
const { compact, standaloneSession, terminalPanelOpen } = storeToRefs(useLayoutStore())
const canOpenInNewWindow = computed(() => client.platform !== "web" && !client.mobile && !standaloneSession.value)
const location = computed(() => fleet.findSession(props.sessionId))
const resourceTarget = useFileTarget(() => location.value?.machine.id)
const view = computed(() => agents.views[props.sessionId])
const snapshot = computed(() => view.value?.snapshot)
const showFirstTaskHandoff = computed(() => {
  const route = router.currentRoute.value
  return route.name === "session" && route.params.sessionId === props.sessionId && route.query.firstTask === "1"
    && snapshot.value?.turns.some(turn => turn.state === "completed")
})
function dismissFirstTaskHandoff(): void {
  const route = router.currentRoute.value
  if (showFirstTaskHandoff.value) void router.replace({ query: { ...route.query, firstTask: undefined } })
}
const projection = useConversationProjection(() => view.value?.events ?? [], snapshot)
const selectUsage = createAgentUsageSelector()
const usage = computed(() => selectUsage(view.value?.events ?? []))
const run = computed(() => snapshot.value?.runs.at(-1))
const activeTurn = computed(() => snapshot.value?.turns.find(turn => liveTurnStates.includes(turn.state)))
const archiveState = computed(() => snapshot.value?.session.archiveState ?? location.value?.session.archiveState)
const active = computed(() => !archiveState.value || archiveState.value === "active")
const connected = computed(() => agents.state === "connected")
// A suspended PWA can lose its peer without unmounting this view. Retry a
// bounded number of times, then wait for a resume or network change.
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let reconnectAttempt = 0
function clearReconnect(): void {
  clearTimeout(reconnectTimer)
  reconnectTimer = undefined
}
function reconnectSession(): void {
  clearReconnect()
  if (disposed || agents.state === "connecting") return
  if (agents.state === "connected" && !view.value?.error) return
  if (agents.relayDeniedReason || location.value?.machine.online === false) return
  void agents.open(props.sessionId)
}
function scheduleReconnect(): void {
  if (disposed || reconnectTimer || agents.relayDeniedReason
    || location.value?.machine.online === false || reconnectAttempt >= 5) return
  const delay = Math.min(1_000 * 2 ** reconnectAttempt, 15_000)
  reconnectAttempt++
  reconnectTimer = setTimeout(() => { reconnectTimer = undefined; reconnectSession() }, delay)
}
watch(() => [agents.state, location.value?.machine.online] as const, ([state, online]) => {
  if (state === "connected") {
    reconnectAttempt = 0
    clearReconnect()
  } else if (state === "error" && online !== false) scheduleReconnect()
}, { immediate: true })
useConnectionResume(() => {
  reconnectAttempt = 0
  clearReconnect()
  if (agents.state !== "connected" || view.value?.error) reconnectSession()
})
onScopeDispose(clearReconnect)
const canResume = computed(() => !snapshot.value?.session.providerSessionId || !!snapshot.value.session.capabilities?.resume)
const canSteer = computed(() => !!snapshot.value?.session.capabilities?.steering && activeTurn.value?.state === "running")
const runActive = computed(() => !!run.value && ["starting", "running"].includes(run.value.state))
const canStop = computed(() => active.value && (runActive.value || snapshot.value?.session.lifecycle === "provisioning"))
const promotedInputIds = computed(() => promotedPendingInputs(snapshot.value, view.value?.events).map(input => input.id))
const canFork = computed(() => active.value && snapshot.value?.session.lifecycle === "ready" && !!snapshot.value.session.capabilities?.fork && !activeTurn.value
  && !snapshot.value.permissions.some(permission => permission.state === "pending")
  && !snapshot.value.elicitations.some(elicitation => elicitation.state === "pending"))
const pendingFork = computed(() => Object.values(agents.operations).find(operation => operation.sessionId === props.sessionId && operation.method === "_deskfleet/session/fork"))
const forkContext = computed(() => {
  const pending = pendingFork.value?.params.context as AgentSessionContext | undefined
  if (pending) return pending
  if (!snapshot.value?.session.workspaceId) return "directory"
  return snapshot.value.session.context ?? "worktree"
})
const forkDisabled = computed(() => !connected.value || !!view.value?.syncing || !!view.value?.error)
// A stopped or interrupted agent resumes on the next message; only a dead end is shown.
const resumeUnavailable = computed(() => snapshot.value?.session.lifecycle === "ready" && run.value?.state !== "running" && !canResume.value)
const additionalDirectoriesUnavailable = computed(() => snapshot.value?.session.capabilities?.additionalDirectories === false && (location.value?.worktree?.directories.length ?? 0) > 1)
const draft = computed({ get: () => agents.drafts[props.sessionId] ?? "", set: value => { agents.drafts[props.sessionId] = value } })
const attachments = computed({ get: () => agents.draftAttachments[props.sessionId] ?? [], set: value => { agents.draftAttachments[props.sessionId] = value } })
const mentions = computed({ get: () => agents.draftMentions[props.sessionId] ?? [], set: value => { agents.draftMentions[props.sessionId] = value } })
const unresolvedSubmission = computed(() => Object.values(agents.operations).some(operation => operation.sessionId === props.sessionId && operation.text === draft.value))
const pending = computed(() => Object.values(agents.operations).filter(operation => operation.sessionId === props.sessionId && operation.error))
// Shells need the Session's own Worktree on this machine.
const terminalWorktree = computed(() => (location.value?.machine.online || terminals.state === "connected") && snapshot.value?.session.lifecycle === "ready" ? location.value?.worktree : undefined)
const applicationTarget = computed(() => client.platform !== "web" && location.value?.machine.local && client.applications && snapshot.value?.session.lifecycle === "ready" && (active.value || snapshot.value.session.context === "directory") && location.value.worktree && location.value.worktree.directories.length > 0
  ? { api: client.applications, machineId: location.value.machine.id, worktreeId: location.value.worktree.id } : undefined)
const openWithMenu = ref<InstanceType<typeof OpenWithMenu> | null>(null)
const empty = computed(() => !view.value?.loading && !agents.optimisticInputs[props.sessionId] && !snapshot.value?.inputs.length && !snapshot.value?.elicitations.length && !view.value?.events.some(event => event.kind === "acp" || event.kind === "input") && snapshot.value?.session.lifecycle !== "provisioning" && run.value?.state !== "starting")
const busy = ref(false)
const forkOpen = ref(false)
const renameOpen = ref(false)
const actionError = ref<string | null>(null)
const draftError = computed(() => actionError.value ?? openWithMenu.value?.launchError ?? agents.draftErrors[props.sessionId])
const scrollRevision = computed(() => [view.value?.events.length, view.value?.syncing])
const faces = useSessionFaces(() => props.sessionId)
watchImmediate(() => props.sessionId, id => {
  busy.value = false
  forkOpen.value = false
  renameOpen.value = false
  actionError.value = null
  void agents.open(id)
})
watchImmediate([() => props.sessionId, () => agents.state], ([id, connection], _, onCleanup) => {
  // A dropped channel already clears attendance. Attend again when this view is still mounted.
  if (connection !== "connected") return
  let left = false
  onCleanup(() => { left = true; void agents.leave(id) })
  void agents.attend(id).then(present => { if (left && present) void agents.leave(id) })
})
useSessionRead(() => props.sessionId)
async function action(operation: () => Promise<unknown>): Promise<void> {
  if (busy.value) return
  const sessionId = props.sessionId
  busy.value = true
  actionError.value = null
  try { await operation() } catch (reason) { if (props.sessionId === sessionId) actionError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { if (props.sessionId === sessionId) busy.value = false }
}
function submit(delivery: "backlog" | "steer"): void {
  if (agents.preparingDrafts[props.sessionId] || hasIncompleteAttachmentUploads(attachments.value, resourceTarget.value)) return
  void action(async () => {
    const sessionId = props.sessionId
    delete agents.draftErrors[sessionId]
    const currentDraft = draft.value
    const currentAttachments = attachments.value
    const currentMentions = mentions.value
    const submittedDraft = { mentions: currentMentions, attachmentIds: currentAttachments.map(item => item.id) }
    const turnId = activeTurn.value?.id
    const content = currentAttachments.length || currentMentions.length
      ? await buildComposerPrompt({ draft: currentDraft, attachments: currentAttachments, mentions: currentMentions,
        providerId: snapshot.value!.session.provider, sessionId, target: resourceTarget.value, filesApi: client.files, resolveReferences: agents.resolveComposerReferences })
      : currentDraft
    const command = commandDraft(typeof content === "string" ? content : content.find(block => block.type === "text")?.text ?? "")
    const intent = command ? "backlog" : delivery
    await agents.submit(sessionId, content, intent, intent === "steer" ? turnId : undefined, currentDraft, submittedDraft)
  })
}
async function showFork(snapshot: AgentSnapshot, sourceId: string): Promise<void> {
  // Open the child before refreshing the catalog: the fork already exists, and a
  // refresh failure must not reject the dialog into allocating another child.
  if (!disposed && router.currentRoute.value.name === "session" && props.sessionId === sourceId) await router.push({ name: "session", params: { sessionId: snapshot.session.id } })
  await fleet.refreshLocalCatalog().catch(() => undefined)
}
async function fork(context: AgentSessionContext): Promise<void> {
  if (busy.value) return
  const sourceId = props.sessionId
  busy.value = true
  try { await showFork(await agents.fork(sourceId, context), sourceId) }
  finally { if (props.sessionId === sourceId) busy.value = false }
}
async function checkOperation(operationId: string): Promise<void> {
  const operation = agents.operations[operationId]
  const result = await agents.checkOperation(operationId)
  if (operation?.method === "_deskfleet/session/fork" && result) await showFork(result as AgentSnapshot, operation.sessionId!)
}
function openInNewWindow(): void {
  const machineId = location.value?.machine.id ?? account?.machineId.value ?? fleet.targetId
  openSessionInNewWindow({
    sessionId: props.sessionId,
    ...(account?.teamId.value ? { teamId: account.teamId.value } : {}),
    ...(machineId ? { machineId } : {}),
  })
}
</script>

<template>
  <SessionHeader :has-actions="!!snapshot || faces.length > 0">
    <template v-if="location">{{ snapshot?.session.title || sessionLabel(location.session) }}<ResourcePath :segments="[location.machine.name, ...(location.workspace ? [location.workspace.name] : [])]" /></template>
    <template #actions>
      <div v-if="snapshot || faces.length" data-session-window-actions class="app-no-drag flex items-center gap-1">
        <template v-if="snapshot">
          <OpenWithMenu v-if="applicationTarget" ref="openWithMenu" :key="applicationTarget.worktreeId" v-bind="applicationTarget" :disabled="!location?.machine.online" split hide-error />
          <UiButton v-if="newTerminalWindow && !compact" variant="ghost" size="icon" :label="t('terminal.new')" :disabled="!location?.worktree" :class="applicationTarget && 'ml-0.5'" data-new-terminal-window @click="newTerminalWindow"><SquareTerminal :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
          <UiButton v-if="compact && !windowedMainWindow && terminalWorktree" variant="ghost" size="icon" :label="t(terminalPanelOpen ? 'terminal.hidePanel' : 'terminal.showPanel')" @click="terminalPanelOpen = !terminalPanelOpen"><SquareTerminal :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
          <AgentSessionMenu :can-stop="canStop" :can-fork="canFork" :fork-disabled="forkDisabled" :can-open-in-new-window="canOpenInNewWindow" :disabled="!location?.machine.online || busy || !!pendingFork" :context="snapshot.session.context" :archive-state="snapshot.session.archiveState" @stop="action(() => agents.stop(sessionId))" @archive="action(() => agents.archive(sessionId))" @restore="action(() => agents.restore(sessionId))" @fork="forkOpen = true" @rename="renameOpen = true" @open-in-new-window="openInNewWindow" />
        </template>
        <UserAvatarStack v-if="faces.length" :people="faces" :size="22" :limit="5" :class="snapshot && 'ml-1'" />
      </div>
    </template>
  </SessionHeader>
  <SessionConversationPane
    v-navigation-motion="compact ? undefined : motion"
    :session-id="sessionId"
    :reading-id="sessionId"
    :loading="view?.loading"
    :ready="!!snapshot"
    :revision="scrollRevision"
    :show-composer="!!location"
    :composer-active="active"
  >
    <template #default="{ focusedEntry }">
      <p v-if="view?.loading" class="m-auto flex items-center gap-2 text-sm text-ui-text-muted" role="status"><LoaderCircle :size="16" :stroke-width="2" class="animate-spin" aria-hidden="true" />{{ t('agent.loading') }}</p>
      <template v-else-if="snapshot">
        <AgentConversation :events="view!.events" :snapshot="snapshot" :projection="projection" :optimistic-input="agents.optimisticInputs[sessionId]" :resource-target="resourceTarget" :notices="agents.notices[sessionId]" :disabled="!active || !connected || busy || !!view?.syncing || !!view?.error" :can-fork="canFork" :fork-disabled="forkDisabled || !location?.machine.online || busy || !!pendingFork" :locate-entry="focusedEntry" @fork="forkOpen = true" @dismiss-notice="agents.dismissNotice(sessionId, $event)">
          <template #live><AgentAuthStatus v-if="agents.authStatuses[sessionId]" :status="agents.authStatuses[sessionId]!" /></template>
        </AgentConversation>
        <p v-if="empty" class="m-auto text-sm text-ui-text-muted">{{ t('agent.empty') }}</p>
      </template>
    </template>
    <template #outline="{ activeEntry, locateEntry }">
      <AgentOutline v-if="snapshot" :events="view!.events" :snapshot="snapshot" :projection="projection" :active="activeEntry" class="absolute left-1 top-1/2 z-20 max-h-[calc(100%-2rem)] -translate-y-1/2" @select="locateEntry" />
    </template>
    <template #notices>
      <ErrorNotice v-if="!view?.loading && (!connected || view?.error)" :title="t('agent.disconnected')" :description="view?.error || agents.error ? undefined : ''" :error="view?.error || agents.error" :relay-denied-reason="view?.error ? view.relayDeniedReason : agents.error ? agents.relayDeniedReason : undefined">
        <UiButton type="button" :disabled="agents.state === 'connecting'" @click="action(() => agents.open(sessionId))">{{ t('agent.reconnect') }}</UiButton>
      </ErrorNotice>
      <ErrorNotice v-for="operation in pending" :key="operation.operationId" :title="t('agent.operationPending')" description="" :error="operation.error">
        <UiButton type="button" :disabled="busy" @click="action(() => checkOperation(operation.operationId))">{{ t('agent.checkResult') }}</UiButton>
      </ErrorNotice>
      <ErrorNotice v-if="draftError && !pending.some(operation => operation.error === draftError)" :error="draftError" />
      <template v-if="snapshot">
        <AgentNotice v-if="showFirstTaskHandoff" :text="t('firstTask.handoff.title')" :detail="t('firstTask.handoff.description')">
          <UiButton type="button" size="sm" class="shrink-0" @click="dismissFirstTaskHandoff">{{ t('firstTask.handoff.dismiss') }}</UiButton>
        </AgentNotice>
        <AgentNotice v-if="!active" :text="t(archiveState === 'archived' ? 'agent.archived' : 'agent.archiving')">
          <UiButton v-if="archiveState === 'archived'" size="sm" type="button" class="shrink-0" :disabled="!location?.machine.online || busy" @click="action(() => agents.restore(sessionId))">{{ t('agent.restore') }}</UiButton>
        </AgentNotice>
        <ErrorNotice v-if="snapshot.session.lifecycle === 'provision_failed'" :title="t('agent.lifecycle.provision_failed')" :error="snapshot.session.error" />
        <AgentNotice v-else-if="snapshot.session.lifecycle === 'deleting'" tone="progress" :text="t(`agent.lifecycle.${snapshot.session.lifecycle}`)" :detail="snapshot.session.error" />
        <ErrorNotice v-else-if="snapshot.session.error" :error="snapshot.session.error" />
        <AgentNotice v-if="additionalDirectoriesUnavailable" tone="warning" :text="t('agent.additionalDirectoriesUnavailable')" :detail="location?.worktree?.directories[0]?.path" />
        <AgentNotice v-if="run?.state === 'stopping'" tone="progress" :text="t(`agent.runState.${run.state}`)" />
        <AgentNotice v-else-if="resumeUnavailable && !runActive && snapshot.session.lifecycle === 'ready'" :text="t('agent.resumeUnavailable')" />
        <AgentPermissions :permissions="snapshot.permissions" :disabled="!active || !connected || busy || !!view?.syncing || !!view?.error" @respond="(id, option) => action(() => agents.respond(sessionId, id, option))" />
        <SessionAllowance :snapshot="snapshot" />
        <AgentBacklog :inputs="snapshot.inputs" :exclude-input-ids="promotedInputIds" :can-steer="canSteer" :disabled="!active || !connected || busy || !!view?.syncing || !!view?.error" @steer="id => action(() => agents.steer(sessionId, id, activeTurn!.id))" @withdraw="id => action(() => agents.withdraw(sessionId, id))" @retry="id => action(() => agents.retry(sessionId, id))" />
      </template>
    </template>
    <template #composer>
      <SessionComposer v-if="active" v-model="draft" v-model:attachments="attachments" v-model:mentions="mentions" :location="location" :usage="usage" :disabled="!connected || !!view?.syncing || !!view?.error || snapshot?.session.lifecycle !== 'ready' || unresolvedSubmission || (run?.state !== 'running' && !canResume)" :submitting="busy || agents.preparingDrafts[sessionId]" :active-turn="!!activeTurn" :can-steer="canSteer" :can-cancel="!!activeTurn && activeTurn.state !== 'cancelling' && connected && !busy && !view?.syncing && !view?.error" @submit="submit" @cancel="action(() => agents.cancel(sessionId, activeTurn!.id))" />
    </template>
  </SessionConversationPane>
  <SessionTerminalPanel v-if="compact && !windowedMainWindow && terminalPanelOpen && terminalWorktree" :key="terminalWorktree.id" :worktree="terminalWorktree" :read-only="!active" />
  <RenameSessionDialog v-if="renameOpen && snapshot" :key="sessionId" :title="snapshot.session.title" :disabled="!location?.machine.online" :confirm="title => agents.rename(sessionId, title)" @close="renameOpen = false" />
  <ForkSessionDialog v-if="forkOpen && snapshot" :key="sessionId" :context="forkContext" :allow-worktree="!!snapshot.session.workspaceId" :retrying="!!pendingFork" :disabled="(!pendingFork && !canFork) || forkDisabled || !location?.machine.online || busy" :confirm="fork" @close="forkOpen = false" />
</template>
