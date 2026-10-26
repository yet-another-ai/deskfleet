<script setup lang="ts">
import { Folder, GitBranch, MessagesSquare } from "@lucide/vue"
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { ScheduleInput, ScheduledTask } from "@deskfleet/client/schedules"
import type { AgentSessionContext } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useAgentSessionsStore, type AgentSelection } from "../../stores/agent-sessions.ts"
import { useProvidersStore } from "../../stores/providers.ts"
import AgentConfigurationSelector from "../composer/AgentConfigurationSelector.vue"
import { localTimeZone } from "./schedule-format.ts"
import ScheduleTiming from "./ScheduleTiming.vue"

const props = defineProps<{
  initial?: ScheduledTask
  disabled?: boolean
  save(schedule: ScheduleInput): Promise<ScheduledTask>
}>()
const emit = defineEmits<{ saved: [schedule: ScheduledTask]; cancel: [] }>()
const { t } = useI18n()
const fleet = useFleetStore()
const agents = useAgentSessionsStore()
const providers = useProvidersStore()
// Where each run goes: a new Session in either context, or the backlog of a Session that already exists.
type Destination = AgentSessionContext | "existing"
const DESTINATIONS = [
  { value: "worktree", icon: GitBranch },
  { value: "directory", icon: Folder },
  { value: "existing", icon: MessagesSquare },
] as const
const title = ref(props.initial?.title ?? "")
const prompt = ref(props.initial?.prompt ?? "")
const workspaceId = ref(props.initial?.workspaceId ?? fleet.targetWorkspaceId ?? fleet.machines[0]?.workspaces[0]?.id ?? "")
const destination = ref<Destination>(props.initial?.target.kind === "existing" ? "existing" : props.initial?.target.context ?? "worktree")
const sessionId = ref(props.initial?.target.kind === "existing" ? props.initial.target.sessionId : "")
const providerId = ref(props.initial?.target.kind === "new" ? props.initial.target.provider : providers.selectedId)
const selection = ref<AgentSelection>(props.initial?.target.kind === "new"
  ? { provider: props.initial.target.provider, ...props.initial.target.configuration }
  : { ...agents.draftConfiguration })
const trigger = ref<ScheduleInput["trigger"]>(JSON.parse(JSON.stringify(props.initial?.trigger ?? { kind: "daily", time: "09:00", timeZone: localTimeZone() })))
const saving = ref(false)
const configurationLoading = ref(false)
const error = ref<string>()
let disposed = false
onBeforeUnmount(() => { disposed = true })
const workspaces = computed(() => fleet.machines[0]?.workspaces ?? [])
const workspace = computed(() => workspaces.value.find(value => value.id === workspaceId.value))
const sessions = computed(() => Object.values(agents.sessions).filter(session => session.workspaceId === workspaceId.value && session.archiveState === "active" && session.lifecycle === "ready"))
const selectedSession = computed(() => sessions.value.find(session => session.id === sessionId.value))
const sessionProvider = computed(() => providers.providers.find(provider => provider.id === selectedSession.value?.provider)?.name ?? selectedSession.value?.provider)
const selectedProvider = computed(() => providers.providers.find(provider => provider.id === providerId.value))
const blocked = computed(() => props.disabled || saving.value)
const timingValid = computed(() => trigger.value.kind === "weekly" ? trigger.value.weekdays.length > 0
  : trigger.value.kind !== "interval" || (Number.isSafeInteger(trigger.value.minutes) && trigger.value.minutes >= 1 && trigger.value.minutes <= 525_600))
const canSave = computed(() => !blocked.value && !!title.value.trim() && !!prompt.value.trim() && !!workspace.value && timingValid.value
  && (destination.value === "existing" ? !!selectedSession.value : providers.ready && !!selectedProvider.value && !configurationLoading.value))
watch(workspaceId, () => { sessionId.value = "" })
watch(() => providers.selectedId, value => { if (!providerId.value) providerId.value = value })

async function submit(): Promise<void> {
  if (!canSave.value) return
  error.value = undefined
  const choices = selection.value.provider === providerId.value ? selection.value : undefined
  const configuration = choices ? { model: choices.model, reasoningEffort: choices.reasoningEffort, mode: choices.mode } : undefined
  const schedule: ScheduleInput = {
    // Pause and Resume own the enabled state; saving the form keeps whatever it currently is.
    title: title.value.trim(), prompt: prompt.value.trim(), workspaceId: workspaceId.value, enabled: props.initial?.enabled ?? true,
    target: destination.value === "existing" ? { kind: "existing", sessionId: sessionId.value }
      : { kind: "new", provider: providerId.value, context: destination.value, ...(configuration && { configuration }) },
    trigger: JSON.parse(JSON.stringify(trigger.value)) as ScheduleInput["trigger"],
  }
  saving.value = true
  try {
    const saved = await props.save(schedule)
    if (!disposed) emit("saved", saved)
  } catch (reason) {
    if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason)
  } finally { if (!disposed) saving.value = false }
}
</script>

<template>
  <form class="flex flex-col gap-7" @submit.prevent="submit">
    <div class="rounded-2xl border border-ui-border bg-ui-surface px-4 pt-4 shadow-ui-card focus-within:border-ui-accent/60">
      <input v-model="title" name="schedule-title" class="block w-full border-b border-ui-border bg-transparent pb-3 text-base font-semibold outline-none" :aria-label="t('schedules.name')" :placeholder="t('schedules.nameHint')" maxlength="200" required :disabled="blocked" />
      <textarea v-model="prompt" name="schedule-prompt" class="mt-3 block min-h-30 w-full resize-y bg-transparent text-sm leading-6 outline-none" :aria-label="t('schedules.prompt')" :placeholder="t('schedules.promptHint')" required :disabled="blocked" />
      <div class="flex min-h-11 items-center pb-2">
        <AgentConfigurationSelector v-if="destination !== 'existing'" v-model:provider-id="providerId" v-model:selection="selection" :workspace-id="workspaceId || undefined" :disabled="blocked" @loading="configurationLoading = $event" />
        <span v-else class="text-[13px] text-ui-text-muted">{{ sessionProvider ?? t('schedules.existingConfiguration') }}</span>
      </div>
    </div>
    <p v-if="destination !== 'existing' && providers.ready && !selectedProvider" role="status" class="m-0 -mt-4 text-[13px] text-ui-text-muted">{{ t('schedules.noProvider') }}</p>

    <section class="flex flex-col gap-3" aria-labelledby="schedule-run-in">
      <h2 id="schedule-run-in" class="ui-section-title">{{ t('schedules.runIn') }}</h2>
      <label class="flex flex-col gap-1.5 text-[13px] text-ui-text-muted">
        {{ t('schedules.workspace') }}
        <select v-model="workspaceId" name="schedule-workspace" class="ui-input max-w-80 text-sm" required :disabled="blocked || !!initial">
          <option value="" disabled>{{ t('schedules.chooseWorkspace') }}</option>
          <option v-if="workspaceId && !workspace" :value="workspaceId" disabled>{{ t('schedules.unavailableWorkspace') }}</option>
          <option v-for="value in workspaces" :key="value.id" :value="value.id">{{ value.name }}</option>
        </select>
      </label>
      <p v-if="!workspaces.length" role="status" class="m-0 text-[13px] text-ui-text-muted">{{ t('schedules.noWorkspace') }}</p>
      <div role="radiogroup" :aria-label="t('schedules.runIn')" class="grid gap-2 sm:grid-cols-3">
        <label v-for="option in DESTINATIONS" :key="option.value" class="relative flex cursor-pointer gap-2.5 rounded-xl border px-3 py-2.5 transition-colors focus-within:ring-2 focus-within:ring-ui-accent/40" :class="[destination === option.value ? 'border-ui-accent/60 bg-ui-accent/6' : 'border-ui-border bg-ui-surface hover:border-ui-border-strong', blocked && 'cursor-default op-60']">
          <input v-model="destination" type="radio" name="schedule-target" :value="option.value" class="sr-only" :disabled="blocked" />
          <component :is="option.icon" :size="16" :stroke-width="1.75" class="mt-0.5 shrink-0" :class="destination === option.value ? 'text-ui-accent' : 'text-ui-text-muted'" aria-hidden="true" />
          <span class="min-w-0">
            <span class="block text-sm font-medium">{{ t(`schedules.destination.${option.value}`) }}</span>
            <span class="mt-0.5 block text-xs leading-4.5 text-ui-text-muted">{{ t(`schedules.destinationHint.${option.value}`) }}</span>
          </span>
        </label>
      </div>
      <label v-if="destination === 'existing'" class="flex flex-col gap-1.5 text-[13px] text-ui-text-muted">
        {{ t('schedules.session') }}
        <select v-model="sessionId" name="schedule-session" class="ui-input max-w-80 text-sm" required :disabled="blocked">
          <option value="" disabled>{{ t('schedules.chooseSession') }}</option>
          <option v-if="sessionId && !selectedSession" :value="sessionId" disabled>{{ t('schedules.unavailableSession') }}</option>
          <option v-for="session in sessions" :key="session.id" :value="session.id">{{ session.title }}</option>
        </select>
      </label>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="schedule-when">
      <h2 id="schedule-when" class="ui-section-title">{{ t('schedules.when') }}</h2>
      <ScheduleTiming v-model="trigger" :disabled="blocked" />
    </section>

    <div class="flex flex-col gap-4 border-t border-ui-border pt-5">
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="flex flex-wrap items-center justify-between gap-4">
        <p class="m-0 max-w-md text-xs leading-5 text-ui-text-muted">{{ t('schedules.executionHint') }}</p>
        <div class="ml-auto flex gap-2">
          <button v-if="!initial" type="button" class="ui-button" :disabled="saving" @click="emit('cancel')">{{ t('schedules.cancel') }}</button>
          <button type="submit" data-schedule-save class="ui-button-primary" :disabled="!canSave">{{ t(saving ? 'catalog.saving' : initial ? 'schedules.save' : 'schedules.createAction') }}</button>
        </div>
      </div>
    </div>
  </form>
</template>
