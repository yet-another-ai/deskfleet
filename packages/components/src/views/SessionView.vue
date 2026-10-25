<script setup lang="ts">
import { LoaderCircle, SquareTerminal } from "@lucide/vue"
import { storeToRefs } from "pinia"
import { watchImmediate } from "@vueuse/core"
import { computed, defineAsyncComponent, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import ResourcePath from "../components/chrome/ResourcePath.vue"
import SessionComposer from "../components/composer/SessionComposer.vue"
import AgentBacklog from "../components/session/AgentBacklog.vue"
import AgentConversation from "../components/session/AgentConversation.vue"
import AgentNotice from "../components/session/AgentNotice.vue"
import AgentPermissions from "../components/session/AgentPermissions.vue"
import AgentSessionMenu from "../components/session/AgentSessionMenu.vue"
import IconButton from "../components/common/IconButton.vue"
import { useFleetStore } from "../stores/fleet.ts"
import { useLayoutStore } from "../stores/layout.ts"
import { useAgentSessionsStore } from "../stores/agent-sessions.ts"
import { useTerminalsStore } from "../stores/terminals.ts"
import { useFileTarget } from "../composables/useFileTarget.ts"
import { useSessionLabel } from "../composables/useSessionLabel.ts"

// xterm stays out of the session bundle until the panel is opened.
const SessionTerminalPanel = defineAsyncComponent(() => import("../components/terminal/SessionTerminalPanel.vue"))
const props = defineProps<{ sessionId: string }>()
const { t } = useI18n()
const sessionLabel = useSessionLabel()
const fleet = useFleetStore()
const agents = useAgentSessionsStore()
const terminals = useTerminalsStore()
const { terminalPanelOpen } = storeToRefs(useLayoutStore())
const location = computed(() => fleet.findSession(props.sessionId))
const resourceTarget = useFileTarget(() => location.value?.machine.id)
const view = computed(() => agents.views[props.sessionId])
const snapshot = computed(() => view.value?.snapshot)
const run = computed(() => snapshot.value?.runs.at(-1))
const activeTurn = computed(() => snapshot.value?.turns.find(turn => ["starting", "running", "cancelling"].includes(turn.state)))
const active = computed(() => !snapshot.value || snapshot.value.session.archiveState === "active")
const connected = computed(() => agents.state === "connected")
const canResume = computed(() => !snapshot.value?.session.providerSessionId || !!snapshot.value.session.capabilities?.resume)
const canSteer = computed(() => !!snapshot.value?.session.capabilities?.steering && activeTurn.value?.state === "running")
const runActive = computed(() => !!run.value && ["starting", "running"].includes(run.value.state))
// A stopped or interrupted agent resumes on the next message; only a dead end is shown.
const resumeUnavailable = computed(() => snapshot.value?.session.lifecycle === "ready" && run.value?.state !== "running" && !canResume.value)
const draft = computed({ get: () => agents.drafts[props.sessionId] ?? "", set: value => { agents.drafts[props.sessionId] = value } })
const unresolvedSubmission = computed(() => Object.values(agents.operations).some(operation => operation.sessionId === props.sessionId && operation.text === draft.value))
const pending = computed(() => Object.values(agents.operations).filter(operation => operation.sessionId === props.sessionId && operation.error))
// Shells need the Session's own Worktree on this machine.
const terminalWorktree = computed(() => (location.value?.machine.online || terminals.state === "connected") && snapshot.value?.session.lifecycle === "ready" ? location.value?.worktree : undefined)
const empty = computed(() => !view.value?.loading && !snapshot.value?.elicitations.length && !view.value?.events.some(event => event.kind === "acp" || event.kind === "input"))
const busy = ref(false)
const actionError = ref<string | null>(null)
const scroller = ref<HTMLElement | null>(null)
const followBottom = ref(true)
const scroll = () => { const el = scroller.value; if (el) followBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 100 }
watchImmediate(() => props.sessionId, id => { busy.value = false; actionError.value = null; followBottom.value = true; void agents.open(id) })
watch(() => [view.value?.events.length, view.value?.loading], () => {
  if (!view.value?.loading && followBottom.value) scroller.value?.scrollTo({ top: scroller.value.scrollHeight })
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
  void action(() => agents.submit(props.sessionId, draft.value, delivery, delivery === "steer" ? activeTurn.value?.id : undefined))
}
</script>

<template>
  <PaneHeader>
    <template v-if="location">{{ snapshot?.session.title || sessionLabel(location.session) }}<ResourcePath :segments="[location.machine.name, location.workspace.name]" /></template>
    <template v-if="snapshot" #actions><IconButton v-if="terminalWorktree" :icon="SquareTerminal" :label="t(terminalPanelOpen ? 'terminal.hidePanel' : 'terminal.showPanel')" @click="terminalPanelOpen = !terminalPanelOpen" /><AgentSessionMenu :can-stop="runActive && active" :disabled="!location?.machine.online || busy" :archive-state="snapshot.session.archiveState" @stop="action(() => agents.stop(sessionId))" @archive="action(() => agents.archive(sessionId))" @restore="action(() => agents.restore(sessionId))" /></template>
  </PaneHeader>
  <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto" @scroll="scroll">
    <div class="mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pt-6 pb-10">
      <p v-if="view?.loading" class="m-auto flex items-center gap-2 text-sm text-ui-text-muted" role="status"><LoaderCircle :size="16" :stroke-width="2" class="animate-spin" aria-hidden="true" />{{ t('agent.loading') }}</p>
      <template v-else-if="snapshot">
        <AgentConversation :events="view!.events" :snapshot="snapshot" :resource-target="resourceTarget" :disabled="!active || !connected || busy || !!view?.error" />
        <p v-if="empty" class="m-auto text-sm text-ui-text-muted">{{ t('agent.empty') }}</p>
      </template>
    </div>
  </div>
  <div v-if="location" class="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-6 pb-2 empty:hidden">
    <AgentNotice v-if="!view?.loading && (!connected || view?.error)" tone="warning" :text="t('agent.disconnected')" :detail="view?.error || agents.error">
      <button type="button" class="ui-button" :disabled="agents.state === 'connecting'" @click="action(() => agents.open(sessionId))">{{ t('agent.reconnect') }}</button>
    </AgentNotice>
    <AgentNotice v-for="operation in pending" :key="operation.operationId" tone="warning" :text="t('agent.operationPending')" :detail="operation.error">
      <button type="button" class="ui-button" :disabled="busy" @click="action(() => agents.checkOperation(operation.operationId))">{{ t('agent.checkResult') }}</button>
    </AgentNotice>
    <AgentNotice v-if="actionError && !pending.some(operation => operation.error === actionError)" tone="danger" :text="actionError" />
    <template v-if="snapshot">
      <AgentNotice v-if="!active" :text="t(snapshot.session.archiveState === 'archived' ? 'agent.archived' : 'agent.archiving')" />
      <AgentNotice v-if="snapshot.session.lifecycle !== 'ready'" :tone="snapshot.session.lifecycle === 'provision_failed' ? 'danger' : 'progress'" :text="t(`agent.lifecycle.${snapshot.session.lifecycle}`)" :detail="snapshot.session.error" />
      <AgentNotice v-else-if="snapshot.session.error" tone="danger" :text="snapshot.session.error" />
      <AgentNotice v-if="run && ['starting', 'stopping'].includes(run.state)" tone="progress" :text="t(`agent.runState.${run.state}`)" />
      <AgentNotice v-else-if="resumeUnavailable" :text="t('agent.resumeUnavailable')" />
      <AgentPermissions :permissions="snapshot.permissions" :disabled="!active || !connected || busy" @respond="(id, option) => action(() => agents.respond(sessionId, id, option))" />
      <AgentBacklog :inputs="snapshot.inputs" :can-steer="canSteer" :disabled="!active || !connected || busy" @steer="id => action(() => agents.steer(sessionId, id, activeTurn!.id))" @withdraw="id => action(() => agents.withdraw(sessionId, id))" @retry="id => action(() => agents.retry(sessionId, id))" />
    </template>
  </div>
  <SessionComposer v-if="location" v-model="draft" :location="location" :disabled="!active || !connected || snapshot?.session.lifecycle !== 'ready' || unresolvedSubmission || (run?.state !== 'running' && !canResume)" :submitting="busy" :active-turn="!!activeTurn" :can-steer="canSteer" :can-cancel="!!activeTurn && activeTurn.state !== 'cancelling' && connected && !busy" @submit="submit" @cancel="action(() => agents.cancel(sessionId, activeTurn!.id))" />
  <SessionTerminalPanel v-if="terminalPanelOpen && terminalWorktree" :key="terminalWorktree.id" :worktree="terminalWorktree" :read-only="!active" />
</template>
