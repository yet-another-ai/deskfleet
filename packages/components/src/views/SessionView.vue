<script setup lang="ts">
import { client } from "@deskfleet/client/platform"
import UiButton from "../components/common/UiButton.vue"
import { LoaderCircle, SquareTerminal } from "@lucide/vue"
import { storeToRefs } from "pinia"
import { watchImmediate } from "@vueuse/core"
import { computed, defineAsyncComponent, nextTick, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter } from "vue-router"
import type { AgentSessionContext, AgentSnapshot } from "../../../../apps/daemon/src/agent-protocol.ts"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import ResourcePath from "../components/chrome/ResourcePath.vue"
import WindowToolbar from "../components/chrome/WindowToolbar.vue"
import SessionComposer from "../components/composer/SessionComposer.vue"
import SessionAllowance from "../components/session/SessionAllowance.vue"
import AgentBacklog from "../components/session/AgentBacklog.vue"
import AgentConversation from "../components/session/AgentConversation.vue"
import AgentNotice from "../components/session/AgentNotice.vue"
import AgentOutline from "../components/session/AgentOutline.vue"
import AgentPermissions from "../components/session/AgentPermissions.vue"
import AgentSessionMenu from "../components/session/AgentSessionMenu.vue"
import RenameSessionDialog from "../components/session/RenameSessionDialog.vue"
import ForkSessionDialog from "../components/session/ForkSessionDialog.vue"
import MermaidViewer from "../components/session/MermaidViewer.vue"
import IconButton from "../components/common/IconButton.vue"
import { useFleetStore } from "../stores/fleet.ts"
import { pendingMermaidLocate, performMermaidLocateDom, useLayoutStore, type MermaidSource } from "../stores/layout.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useTerminalsStore } from "../stores/terminals.ts"
import { useFileTarget } from "../composables/useFileTarget.ts"
import { useSessionLabel } from "../composables/useSessionLabel.ts"
import { latestAgentUsage } from "../services/agent-usage.ts"
import { buildComposerPrompt } from "../services/composer-prompt.ts"
import { commandDraft } from "../services/composer-mentions.ts"

// xterm stays out of the session bundle until the panel is opened.
const SessionTerminalPanel = defineAsyncComponent(() => import("../components/terminal/SessionTerminalPanel.vue"))
const props = defineProps<{ sessionId: string }>()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const sessionLabel = useSessionLabel()
const fleet = useFleetStore()
const agents = useAgentSessionsStore()
const terminals = useTerminalsStore()
const { sidebarOpen, terminalPanelOpen } = storeToRefs(useLayoutStore())
const focusedMermaid = computed(() => typeof route.query.mermaid === "string" && route.query.mermaid ? route.query.mermaid : undefined)
const focusedMermaidSource = computed<MermaidSource>(() => ({
  sessionId: props.sessionId,
  ...(typeof route.query.mermaidEntry === "string" && route.query.mermaidEntry ? { entryId: route.query.mermaidEntry } : {}),
  ...(typeof route.query.mermaidDiagram === "string" && route.query.mermaidDiagram ? { diagramId: route.query.mermaidDiagram } : {}),
}))
const location = computed(() => fleet.findSession(props.sessionId))
const resourceTarget = useFileTarget(() => location.value?.machine.id)
const view = computed(() => agents.views[props.sessionId])
const snapshot = computed(() => view.value?.snapshot)
const usage = computed(() => latestAgentUsage(view.value?.events ?? []))
const run = computed(() => snapshot.value?.runs.at(-1))
const activeTurn = computed(() => snapshot.value?.turns.find(turn => ["starting", "running", "cancelling"].includes(turn.state)))
const active = computed(() => !snapshot.value || snapshot.value.session.archiveState === "active")
const connected = computed(() => agents.state === "connected")
const canResume = computed(() => !snapshot.value?.session.providerSessionId || !!snapshot.value.session.capabilities?.resume)
const canSteer = computed(() => !!snapshot.value?.session.capabilities?.steering && activeTurn.value?.state === "running")
const runActive = computed(() => !!run.value && ["starting", "running"].includes(run.value.state))
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
const forkDisabled = computed(() => !connected.value || !!view.value?.loading || !!view.value?.error)
// A stopped or interrupted agent resumes on the next message; only a dead end is shown.
const resumeUnavailable = computed(() => snapshot.value?.session.lifecycle === "ready" && run.value?.state !== "running" && !canResume.value)
const draft = computed({ get: () => agents.drafts[props.sessionId] ?? "", set: value => { agents.drafts[props.sessionId] = value } })
const attachments = computed({ get: () => agents.draftAttachments[props.sessionId] ?? [], set: value => { agents.draftAttachments[props.sessionId] = value } })
const mentions = computed({ get: () => agents.draftMentions[props.sessionId] ?? [], set: value => { agents.draftMentions[props.sessionId] = value } })
const unresolvedSubmission = computed(() => Object.values(agents.operations).some(operation => operation.sessionId === props.sessionId && operation.text === draft.value))
const pending = computed(() => Object.values(agents.operations).filter(operation => operation.sessionId === props.sessionId && operation.error))
// Shells need the Session's own Worktree on this machine.
const terminalWorktree = computed(() => (location.value?.machine.online || terminals.state === "connected") && snapshot.value?.session.lifecycle === "ready" ? location.value?.worktree : undefined)
const empty = computed(() => !view.value?.loading && !snapshot.value?.elicitations.length && !view.value?.events.some(event => event.kind === "acp" || event.kind === "input"))
const busy = ref(false)
const forkOpen = ref(false)
const renameOpen = ref(false)
const actionError = ref<string | null>(null)
const draftError = computed(() => actionError.value ?? agents.draftErrors[props.sessionId])
const scroller = ref<HTMLElement | null>(null)
const followBottom = ref(true)
const activeEntry = ref<string>()

function updateOutline(): void {
  const el = scroller.value
  if (!el) return
  const entries = Array.from(el.querySelectorAll<HTMLElement>("ol > li[data-conversation-entry]"))
  if (followBottom.value) {
    activeEntry.value = entries.at(-1)?.dataset.conversationEntry
    return
  }
  const threshold = el.getBoundingClientRect().top + 80
  const current = entries.findLast(entry => entry.getBoundingClientRect().top <= threshold) ?? entries[0]
  activeEntry.value = current?.dataset.conversationEntry
}

function scroll(): void {
  const el = scroller.value
  if (!el) return
  followBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 100
  updateOutline()
}

function locateEntry(id: string): void {
  const entry = scroller.value?.querySelector<HTMLElement>(`[data-conversation-entry=${JSON.stringify(id)}]`)
  if (!entry) return
  followBottom.value = false
  entry.scrollIntoView({ block: "start", behavior: "instant" })
  activeEntry.value = id
}

watchImmediate(() => props.sessionId, id => {
  busy.value = false
  forkOpen.value = false
  renameOpen.value = false
  actionError.value = null
  activeEntry.value = undefined
  followBottom.value = !pendingMermaidLocate.value || (!!pendingMermaidLocate.value.sessionId && pendingMermaidLocate.value.sessionId !== id)
  void agents.open(id)
})
watch(() => [view.value?.events.length, view.value?.loading], () => {
  if (!view.value?.loading && followBottom.value && !pendingMermaidLocate.value) scroller.value?.scrollTo({ top: scroller.value.scrollHeight })
  if (followBottom.value || !activeEntry.value) updateOutline()
}, { flush: "post" })
watch([pendingMermaidLocate, () => view.value?.loading, () => view.value?.events.length, focusedMermaid], async ([target, loading, , focused]) => {
  if (!target || loading || focused) return
  if (target.sessionId && target.sessionId !== props.sessionId) return
  followBottom.value = false
  await nextTick()
  performMermaidLocateDom(target)
}, { flush: "post" })
async function action(operation: () => Promise<unknown>): Promise<void> {
  if (busy.value) return
  const sessionId = props.sessionId
  busy.value = true
  actionError.value = null
  try { await operation() } catch (reason) { if (props.sessionId === sessionId) actionError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { if (props.sessionId === sessionId) busy.value = false }
}
function submit(delivery: "backlog" | "steer"): void {
  if (agents.preparingDrafts[props.sessionId]) return
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
  if (router.currentRoute.value.name === "session" && props.sessionId === sourceId) await router.push({ name: "session", params: { sessionId: snapshot.session.id } })
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
</script>

<template>
  <PaneHeader>
    <template v-if="location">{{ snapshot?.session.title || sessionLabel(location.session) }}<ResourcePath :segments="[location.machine.name, ...(location.workspace ? [location.workspace.name] : [])]" /></template>
    <template v-if="snapshot" #actions><IconButton v-if="terminalWorktree" :icon="SquareTerminal" :label="t(terminalPanelOpen ? 'terminal.hidePanel' : 'terminal.showPanel')" @click="terminalPanelOpen = !terminalPanelOpen" /><AgentSessionMenu :can-stop="runActive && active" :can-fork="canFork" :fork-disabled="forkDisabled" :disabled="!location?.machine.online || busy || !!pendingFork" :archive-state="snapshot.session.archiveState" @stop="action(() => agents.stop(sessionId))" @archive="action(() => agents.archive(sessionId))" @restore="action(() => agents.restore(sessionId))" @fork="forkOpen = true" @rename="renameOpen = true" /></template>
  </PaneHeader>
  <div class="relative flex min-h-0 flex-1">
    <AgentOutline
      v-if="snapshot && !view?.loading"
      :events="view!.events"
      :snapshot="snapshot"
      :active="activeEntry"
      class="absolute left-1 top-1/2 z-10 max-h-[calc(100%-2rem)] -translate-y-1/2"
      @select="locateEntry"
    />
    <div ref="scroller" class="min-h-0 min-w-0 flex-1 overflow-y-auto pl-8" @scroll="scroll">
      <div class="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pt-6 pb-10">
        <p v-if="view?.loading" class="m-auto flex items-center gap-2 text-sm text-ui-text-muted" role="status"><LoaderCircle :size="16" :stroke-width="2" class="animate-spin" aria-hidden="true" />{{ t('agent.loading') }}</p>
        <template v-else-if="snapshot">
          <AgentConversation :events="view!.events" :snapshot="snapshot" :resource-target="resourceTarget" :disabled="!active || !connected || busy || !!view?.error" />
          <p v-if="empty" class="m-auto text-sm text-ui-text-muted">{{ t('agent.empty') }}</p>
        </template>
      </div>
    </div>
  </div>
  <div v-if="location" class="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-6 pb-2 empty:hidden">
    <AgentNotice v-if="!view?.loading && (!connected || view?.error)" tone="warning" :text="t('agent.disconnected')" :detail="view?.error || agents.error">
      <UiButton type="button" :disabled="agents.state === 'connecting'" @click="action(() => agents.open(sessionId))">{{ t('agent.reconnect') }}</UiButton>
    </AgentNotice>
    <AgentNotice v-for="operation in pending" :key="operation.operationId" tone="warning" :text="t('agent.operationPending')" :detail="operation.error">
      <UiButton type="button" :disabled="busy" @click="action(() => checkOperation(operation.operationId))">{{ t('agent.checkResult') }}</UiButton>
    </AgentNotice>
    <AgentNotice v-if="draftError && !pending.some(operation => operation.error === draftError)" tone="danger" :text="draftError" />
    <template v-if="snapshot">
      <AgentNotice v-if="!active" :text="t(snapshot.session.archiveState === 'archived' ? 'agent.archived' : 'agent.archiving')" />
      <AgentNotice v-if="snapshot.session.lifecycle !== 'ready'" :tone="snapshot.session.lifecycle === 'provision_failed' ? 'danger' : 'progress'" :text="t(`agent.lifecycle.${snapshot.session.lifecycle}`)" :detail="snapshot.session.error" />
      <AgentNotice v-else-if="snapshot.session.error" tone="danger" :text="snapshot.session.error" />
      <AgentNotice v-if="run && ['starting', 'stopping'].includes(run.state)" tone="progress" :text="t(`agent.runState.${run.state}`)" />
      <AgentNotice v-else-if="resumeUnavailable" :text="t('agent.resumeUnavailable')" />
      <AgentPermissions :permissions="snapshot.permissions" :disabled="!active || !connected || busy" @respond="(id, option) => action(() => agents.respond(sessionId, id, option))" />
      <SessionAllowance :snapshot="snapshot" />
      <AgentBacklog :inputs="snapshot.inputs" :can-steer="canSteer" :disabled="!active || !connected || busy" @steer="id => action(() => agents.steer(sessionId, id, activeTurn!.id))" @withdraw="id => action(() => agents.withdraw(sessionId, id))" @retry="id => action(() => agents.retry(sessionId, id))" />
    </template>
  </div>
  <SessionComposer v-if="location" v-model="draft" v-model:attachments="attachments" v-model:mentions="mentions" :location="location" :usage="usage" :disabled="!active || !connected || snapshot?.session.lifecycle !== 'ready' || unresolvedSubmission || (run?.state !== 'running' && !canResume)" :submitting="busy || agents.preparingDrafts[sessionId]" :active-turn="!!activeTurn" :can-steer="canSteer" :can-cancel="!!activeTurn && activeTurn.state !== 'cancelling' && connected && !busy" @submit="submit" @cancel="action(() => agents.cancel(sessionId, activeTurn!.id))" />
  <SessionTerminalPanel v-if="terminalPanelOpen && terminalWorktree" :key="terminalWorktree.id" :worktree="terminalWorktree" :read-only="!active" />
  <RenameSessionDialog v-if="renameOpen && snapshot" :key="sessionId" :title="snapshot.session.title" :disabled="!location?.machine.online" :confirm="title => agents.rename(sessionId, title)" @close="renameOpen = false" />
  <ForkSessionDialog v-if="forkOpen && snapshot" :key="sessionId" :context="forkContext" :allow-worktree="!!snapshot.session.workspaceId" :retrying="!!pendingFork" :disabled="(!pendingFork && !canFork) || forkDisabled || !location?.machine.online || busy" :confirm="fork" @close="forkOpen = false" />
  <div v-if="focusedMermaid" data-mermaid-focus-view class="absolute inset-0 z-20 flex flex-col bg-ui-canvas">
    <div v-if="!sidebarOpen" class="app-drag flex h-12 shrink-0 items-center border-b border-ui-border pl-20 pr-3">
      <WindowToolbar />
    </div>
    <MermaidViewer :key="focusedMermaid" :code="focusedMermaid" :source="focusedMermaidSource" mode="focus" class="min-h-0 flex-1 rounded-none border-0" />
  </div>
</template>
