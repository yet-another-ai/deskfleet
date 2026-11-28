<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import UiSelect from "../common/UiSelect.vue"
import UiSwitch from "../common/UiSwitch.vue"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import { RadioGroupItem, RadioGroupRoot } from "reka-ui"
import { Folder, GitBranch, MessagesSquare, Zap } from "@lucide/vue"
import { useConfirmDialog } from "@vueuse/core"
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { ScheduleInput, ScheduledTask } from "@deskfleet/client/schedules"
import type { AgentSessionContext } from "@deskfleet/protocol/agent"
import { inferDefaultDeliveryPolicy, type FollowUpDeliveryPolicy } from "@deskfleet/protocol/super-agent-follow-up"
import { useFleetStore } from "../../stores/fleet.ts"
import { useAgentSessionsStore, type AgentSelection } from "../../stores/agent-sessions.ts"
import { useProvidersStore } from "../../stores/providers.ts"
import AgentConfigurationSelector from "../composer/AgentConfigurationSelector.vue"
import { localTimeZone } from "./schedule-format.ts"
import ScheduleTiming from "./ScheduleTiming.vue"

export interface ScheduleFollowUpOption {
  supported: boolean
  authorized: boolean
  awaitingAuthorization?: boolean
  initialEnabled?: boolean
  initialPolicy?: FollowUpDeliveryPolicy
  connect(task: ScheduledTask, enabled: boolean, policy: FollowUpDeliveryPolicy): Promise<void>
}

const props = defineProps<{
  initial?: ScheduledTask
  disabled?: boolean
  followUp?: ScheduleFollowUpOption
  save(schedule: ScheduleInput, options?: { operationId?: string; scheduleId?: string }): Promise<ScheduledTask>
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
const yolo = ref(props.initial?.yolo === true)
const showFollowUp = computed(() => !!props.followUp?.supported && !!props.followUp?.authorized)
const followUpEnabled = ref(props.followUp?.initialEnabled ?? true)
const policyTouched = ref(props.followUp?.initialPolicy !== undefined)
const deliveryPolicy = ref<FollowUpDeliveryPolicy>(props.followUp?.initialPolicy ?? inferDefaultDeliveryPolicy(title.value, prompt.value))
const pendingConnectTask = ref<ScheduledTask>()
const saving = ref(false)
const configurationLoading = ref(false)
const error = ref<string>()
const yoloConfirmation = useConfirmDialog()
const { isRevealed: confirmingYolo } = yoloConfirmation
let pendingCreateIds: { operationId: string; scheduleId: string; fingerprint: string } | undefined
let disposed = false
onBeforeUnmount(() => { disposed = true })

watch([title, prompt], ([nextTitle, nextPrompt]) => {
  if (!policyTouched.value) deliveryPolicy.value = inferDefaultDeliveryPolicy(nextTitle, nextPrompt)
})
watch(() => [props.followUp?.initialEnabled, props.followUp?.initialPolicy] as const, ([enabledVal, policyVal]) => {
  if (enabledVal !== undefined) followUpEnabled.value = enabledVal
  if (policyVal !== undefined) { deliveryPolicy.value = policyVal; policyTouched.value = true }
})

const workspaces = computed(() => fleet.machines[0]?.workspaces ?? [])
const workspace = computed(() => workspaces.value.find(value => value.id === workspaceId.value))
const sessions = computed(() => Object.values(agents.sessions).filter(session => session.workspaceId === workspaceId.value && session.archiveState === "active" && session.lifecycle === "ready"))
const selectedSession = computed(() => sessions.value.find(session => session.id === sessionId.value))
const sessionProvider = computed(() => providers.providers.find(provider => provider.id === selectedSession.value?.provider)?.name ?? selectedSession.value?.provider)
const selectedProvider = computed(() => providers.providers.find(provider => provider.id === providerId.value))
const blocked = computed(() => props.disabled || saving.value)
const timingValid = computed(() => trigger.value.kind === "weekly" ? trigger.value.weekdays.length > 0
  : trigger.value.kind !== "interval" || (Number.isSafeInteger(trigger.value.minutes) && trigger.value.minutes >= 1 && trigger.value.minutes <= 525_600))
const canSave = computed(() => !blocked.value && !pendingConnectTask.value && !!title.value.trim() && !!prompt.value.trim() && !!workspace.value && timingValid.value
  && (destination.value === "existing" ? !!selectedSession.value : providers.ready && !!selectedProvider.value && !configurationLoading.value))
watch(workspaceId, () => { sessionId.value = "" })
watch(() => providers.selectedId, value => { if (!providerId.value) providerId.value = value })
watch(() => props.disabled, value => { if (value) yoloConfirmation.cancel() })

async function toggleYolo(): Promise<void> {
  if (blocked.value || confirmingYolo.value) return
  if (!yolo.value && (await yoloConfirmation.reveal()).isCanceled) return
  yolo.value = !yolo.value
}

async function retryConnectFollowUp(): Promise<void> {
  const existing = pendingConnectTask.value
  if (!existing || !props.followUp || saving.value) return
  error.value = undefined
  saving.value = true
  try {
    await props.followUp.connect(existing, followUpEnabled.value, deliveryPolicy.value)
    if (!disposed) {
      pendingConnectTask.value = undefined
      emit("saved", existing)
    }
  } catch (reason) {
    if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason)
  } finally { if (!disposed) saving.value = false }
}

async function submit(): Promise<void> {
  if (!canSave.value) return
  error.value = undefined
  const choices = selection.value.provider === providerId.value ? selection.value : undefined
  const configuration = choices ? { model: choices.model, reasoningEffort: choices.reasoningEffort, mode: choices.mode,
    ...(choices.configValues && { configValues: choices.configValues }),
  } : undefined
  const schedule: ScheduleInput = {
    // Pause and Resume own the enabled state; saving the form keeps whatever it currently is.
    title: title.value.trim(), prompt: prompt.value.trim(), workspaceId: workspaceId.value, enabled: props.initial?.enabled ?? true,
    // Creates omit false for older daemons; edits always send the flag so clearing YOLO sticks.
    ...(props.initial || yolo.value ? { yolo: yolo.value } : {}),
    target: destination.value === "existing" ? { kind: "existing", sessionId: sessionId.value }
      : { kind: "new", provider: providerId.value, context: destination.value, ...(configuration && { configuration }) },
    trigger: JSON.parse(JSON.stringify(trigger.value)) as ScheduleInput["trigger"],
  }
  const fingerprint = JSON.stringify(schedule)
  let saveOptions: { operationId?: string; scheduleId?: string } | undefined
  if (showFollowUp.value && !props.initial) {
    if (!pendingCreateIds || pendingCreateIds.fingerprint !== fingerprint) {
      pendingCreateIds = { operationId: crypto.randomUUID(), scheduleId: crypto.randomUUID(), fingerprint }
    }
    saveOptions = { operationId: pendingCreateIds.operationId, scheduleId: pendingCreateIds.scheduleId }
  }
  saving.value = true
  try {
    const saved = saveOptions ? await props.save(schedule, saveOptions) : await props.save(schedule)
    pendingCreateIds = undefined
    if (showFollowUp.value && props.followUp) {
      try {
        await props.followUp.connect(saved, followUpEnabled.value, deliveryPolicy.value)
      } catch (connectErr) {
        // Keep the created schedule and offer "Connect existing schedule" instead of creating a duplicate!
        if (!disposed) {
          pendingConnectTask.value = saved
          error.value = connectErr instanceof Error ? connectErr.message : String(connectErr)
        }
        return
      }
    }
    if (!disposed) emit("saved", saved)
  } catch (reason) {
    if (!disposed) error.value = reason instanceof Error ? reason.message : String(reason)
  } finally { if (!disposed) saving.value = false }
}
</script>

<template>
  <form class="flex flex-col gap-7" @submit.prevent="submit">
    <div class="rounded-2xl border border-ui-border bg-ui-surface px-4 pt-4 focus-within:border-ui-accent/60">
      <input v-model="title" name="schedule-title" class="block w-full border-b border-ui-border bg-transparent pb-3 text-base font-semibold outline-none" :aria-label="t('schedules.name')" :placeholder="t('schedules.nameHint')" maxlength="200" required :disabled="blocked || !!pendingConnectTask" />
      <textarea v-model="prompt" name="schedule-prompt" class="mt-3 block min-h-30 w-full resize-y bg-transparent text-sm leading-6 outline-none" :aria-label="t('schedules.prompt')" :placeholder="t('schedules.promptHint')" required :disabled="blocked || !!pendingConnectTask" />
      <div class="flex min-h-11 items-center pb-2">
        <AgentConfigurationSelector v-if="destination !== 'existing'" v-model:provider-id="providerId" v-model:selection="selection" :workspace-id="workspaceId || undefined" :disabled="blocked || !!pendingConnectTask" @loading="configurationLoading = $event" />
        <span v-else class="text-[13px] text-ui-text-muted">{{ sessionProvider ?? t('schedules.existingConfiguration') }}</span>
      </div>
    </div>
    <p v-if="destination !== 'existing' && providers.ready && !selectedProvider" role="status" class="m-0 -mt-4 text-[13px] text-ui-text-muted">{{ t('schedules.noProvider') }}</p>

    <section class="flex flex-col gap-3" aria-labelledby="schedule-run-in">
      <h2 id="schedule-run-in" class="ui-section-title">{{ t('schedules.runIn') }}</h2>
      <label class="flex flex-col gap-1.5 text-[13px] text-ui-text-muted">
        {{ t('schedules.workspace') }}
        <UiSelect v-model="workspaceId" name="schedule-workspace" class="max-w-80" :aria-label="t('schedules.workspace')" :placeholder="t('schedules.chooseWorkspace')" :options="[...(workspaceId && !workspace ? [{ value: workspaceId, label: t('schedules.unavailableWorkspace'), disabled: true }] : []), ...workspaces.map(value => ({ value: value.id, label: value.name }))]" required :disabled="blocked || !!initial || !!pendingConnectTask" />
      </label>
      <p v-if="!workspaces.length" role="status" class="m-0 text-[13px] text-ui-text-muted">{{ t('schedules.noWorkspace') }}</p>
      <RadioGroupRoot :model-value="destination" name="schedule-target" :disabled="blocked || !!pendingConnectTask" :aria-label="t('schedules.runIn')" class="grid gap-2 sm:grid-cols-3" @update:model-value="destination = $event as Destination">
        <RadioGroupItem v-for="option in DESTINATIONS" :key="option.value" :value="option.value" class="relative flex cursor-pointer gap-2.5 rounded-xl border px-3 py-2.5 text-left ui-motion" :class="[destination === option.value ? 'border-ui-accent/60 bg-ui-accent/6 hover:bg-ui-accent/12' : 'border-ui-border bg-ui-surface hover:border-ui-border-strong hover:bg-ui-hover', blocked && 'cursor-default op-60']">
          <component :is="option.icon" :size="16" :stroke-width="1.75" class="mt-0.5 shrink-0" :class="destination === option.value ? 'text-ui-accent' : 'text-ui-text-muted'" aria-hidden="true" />
          <span class="min-w-0">
            <span class="block text-sm font-medium">{{ t(`schedules.destination.${option.value}`) }}</span>
            <span class="mt-0.5 block text-xs leading-4.5 text-ui-text-muted">{{ t(`schedules.destinationHint.${option.value}`) }}</span>
          </span>
        </RadioGroupItem>
      </RadioGroupRoot>
      <label v-if="destination === 'existing'" class="flex flex-col gap-1.5 text-[13px] text-ui-text-muted">
        {{ t('schedules.session') }}
        <UiSelect v-model="sessionId" name="schedule-session" class="max-w-80" :aria-label="t('schedules.session')" :placeholder="t('schedules.chooseSession')" :options="[...(sessionId && !selectedSession ? [{ value: sessionId, label: t('schedules.unavailableSession'), disabled: true }] : []), ...sessions.map(session => ({ value: session.id, label: session.title }))]" required :disabled="blocked || !!pendingConnectTask" />
      </label>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="schedule-when">
      <h2 id="schedule-when" class="ui-section-title">{{ t('schedules.when') }}</h2>
      <ScheduleTiming v-model="trigger" :disabled="blocked || !!pendingConnectTask" />
    </section>

    <section v-if="showFollowUp" class="flex flex-col gap-3" aria-labelledby="schedule-follow-up">
      <h2 id="schedule-follow-up" class="ui-section-title">{{ t('superAgent.followUp.followUpLabel') }}</h2>
      <div class="flex flex-col gap-3 rounded-xl border border-ui-border bg-ui-surface px-3.5 py-3">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="text-sm font-medium">{{ t('superAgent.followUp.followUpLabel') }}</div>
            <p class="m-0 mt-0.5 text-xs leading-4.5 text-ui-text-muted">{{ t('superAgent.followUp.followUpHint') }}</p>
          </div>
          <UiSwitch v-model="followUpEnabled" data-schedule-follow-up-toggle :aria-label="t('superAgent.followUp.followUpLabel')" :disabled="blocked" />
        </div>
        <label v-if="followUpEnabled" class="flex flex-col gap-1.5 text-[13px] text-ui-text-muted">
          {{ t('superAgent.followUp.reportPreference') }}
          <UiSelect
            :model-value="deliveryPolicy"
            name="schedule-delivery-policy"
            class="max-w-sm"
            :aria-label="t('superAgent.followUp.reportPreference')"
            :options="[
              { value: 'every_run', label: t('superAgent.followUp.everyRun') },
              { value: 'exceptions_only', label: t('superAgent.followUp.exceptionsOnly') },
            ]"
            :disabled="blocked"
            @update:model-value="policyTouched = true; deliveryPolicy = $event as FollowUpDeliveryPolicy"
          />
        </label>
        <p class="m-0 text-xs text-ui-text-muted">{{ t('superAgent.followUp.teamVisibilityHint') }}</p>
      </div>
    </section>

    <section class="flex flex-col gap-3" aria-labelledby="schedule-approvals">
      <h2 id="schedule-approvals" class="ui-section-title">{{ t('schedules.approvals') }}</h2>
      <button
        type="button"
        class="flex max-w-xl cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-left ui-motion disabled:cursor-default disabled:opacity-60"
        :class="yolo ? 'border-ui-accent/60 bg-ui-accent/6 hover:bg-ui-accent/12' : 'border-ui-border bg-ui-surface hover:border-ui-border-strong hover:bg-ui-hover'"
        :aria-pressed="yolo"
        :aria-label="t('schedules.yoloHint')"
        data-schedule-yolo
        :disabled="blocked || !!pendingConnectTask"
        @click="toggleYolo"
      >
        <Zap :size="16" :stroke-width="1.75" :fill="yolo ? 'currentColor' : 'none'" class="mt-0.5 shrink-0" :class="yolo ? 'text-ui-accent' : 'text-ui-text-muted'" aria-hidden="true" />
        <span class="min-w-0">
          <span class="block text-sm font-medium">{{ t('schedules.yolo') }}</span>
          <span class="mt-0.5 block text-xs leading-4.5 text-ui-text-muted">{{ t('schedules.yoloHint') }}</span>
        </span>
      </button>
    </section>

    <div class="flex flex-col gap-4 border-t border-ui-border pt-5">
      <div v-if="pendingConnectTask" role="alert" class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ui-danger/40 bg-ui-danger/6 px-3.5 py-2.5 text-sm">
        <div class="min-w-0">
          <p class="m-0 font-medium text-ui-danger">{{ error }}</p>
          <p class="m-0 mt-0.5 text-xs text-ui-text-muted">{{ t('superAgent.followUp.connectExistingHint') }}</p>
        </div>
        <UiButton type="button" variant="primary" size="sm" data-schedule-connect-existing :loading="saving" @click="retryConnectFollowUp">{{ t('superAgent.followUp.connectExisting') }}</UiButton>
      </div>
      <p v-else-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="flex flex-wrap items-center justify-between gap-4">
        <p class="m-0 max-w-md text-xs leading-5 text-ui-text-muted">{{ t(yolo ? 'schedules.executionHintYolo' : 'schedules.executionHint') }}</p>
        <div class="ml-auto flex gap-2">
          <UiButton v-if="!initial" type="button" :disabled="saving" @click="emit('cancel')">{{ t('schedules.cancel') }}</UiButton>
          <UiButton variant="primary" type="submit" :loading="saving" data-schedule-save :disabled="!canSave">{{ t(saving ? 'catalog.saving' : initial ? 'schedules.save' : 'schedules.createAction') }}</UiButton>
        </div>
      </div>
    </div>
    <ConfirmDialog
      v-if="confirmingYolo"
      :title="t('schedules.yoloConfirmation.title')"
      :description="t('schedules.yoloConfirmation.description')"
      :confirm-label="t('schedules.yoloConfirmation.confirm')"
      :confirm="async () => { yoloConfirmation.confirm() }"
      @close="yoloConfirmation.cancel()"
    />
  </form>
</template>
