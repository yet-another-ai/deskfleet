<script setup lang="ts">
import { vNavigationMotion } from "../directives/navigation-motion.ts"
import { useNavigationMotion } from "../composables/useNavigationMotion.ts"
import UiButton from "../components/common/UiButton.vue"
import UiScrollArea from "../components/common/UiScrollArea.vue"
import ErrorNotice from "../components/common/ErrorNotice.vue"
import { CalendarClock, Plus } from "@lucide/vue"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink, useRouter } from "vue-router"
import type { ScheduleInput, ScheduledTask } from "@deskfleet/client/schedules"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import ConfirmDialog from "../components/common/ConfirmDialog.vue"
import ScheduleDetail from "../components/schedules/ScheduleDetail.vue"
import ScheduleEditor, { type ScheduleFollowUpOption } from "../components/schedules/ScheduleEditor.vue"
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import { useScheduledTasks } from "../composables/useScheduledTasks.ts"
import { useWorkspaceAgentMode, workspaceAgentRoute } from "../services/workspace-agent-navigation.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { absoluteTime } from "../components/schedules/schedule-format.ts"
import type { FollowUpDeliveryPolicy, FollowUpSourcesResponse } from "@deskfleet/protocol/super-agent"

// `/schedules` prompts to select or create a task, `/schedules/new` creates one, and `/schedules/:id` shows one.
const props = defineProps<{ scheduleId?: string }>()
const { t, locale } = useI18n()
const motion = useNavigationMotion()
const router = useRouter()
const fleet = useFleetStore()
const client = usePlatformClient()
const workspaceMode = useWorkspaceAgentMode()
const schedules = useScheduledTasks()
const { account, online, tasks, loaded, loading, pending, error, lastObservedAt } = schedules
const creating = computed(() => props.scheduleId === "new")
const selected = computed(() => props.scheduleId && !creating.value ? tasks.value.find(task => task.id === props.scheduleId) : undefined)
const machineName = computed(() => account?.machine.value?.name ?? fleet.machines[0]?.name)
const blocked = computed(() => !online.value || pending.value)
const removing = ref<ScheduledTask>()
const followUpState = ref<FollowUpSourcesResponse>()

async function refreshFollowUpSources(): Promise<void> {
  if (!workspaceMode.value || !online.value || !client.superAgent?.followUpSources) {
    followUpState.value = undefined
    return
  }
  try { followUpState.value = await client.superAgent.followUpSources({ workspaceId: null }) }
  catch { followUpState.value = undefined }
}
watch([workspaceMode, online, () => fleet.targetId, () => props.scheduleId], () => { void refreshFollowUpSources() }, { immediate: true })

async function connectFollowUp(task: ScheduledTask, enabled: boolean, deliveryPolicy: FollowUpDeliveryPolicy): Promise<void> {
  if (!client.superAgent?.followUpUpdateSource) throw new Error("Proactive follow-up is unavailable on this host")
  await client.superAgent.followUpUpdateSource({ workspaceId: task.workspaceId, sourceKind: "schedule", sourceId: task.id, enabled, deliveryPolicy })
  await refreshFollowUpSources()
}

const editorFollowUp = computed<ScheduleFollowUpOption | undefined>(() => {
  if (!workspaceMode.value || !followUpState.value) return undefined
  const existing = selected.value
    ? followUpState.value.sources.find(s => s.sourceKind === "schedule" && s.sourceId === selected.value!.id && s.workspaceId === selected.value!.workspaceId)
    : undefined
  const awaitingAuthorization = existing?.state.pausedReason === "awaiting_authorization"
  const takeoverActive = followUpState.value.auth.authorized && followUpState.value.auth.takeoverAllSessions !== false
  if (!takeoverActive && !awaitingAuthorization) return undefined
  return {
    supported: true,
    authorized: takeoverActive,
    awaitingAuthorization,
    initialEnabled: selected.value ? (existing ? existing.state.enabled && !existing.state.pausedReason : false) : true,
    initialPolicy: existing?.state.deliveryPolicy,
    connect: connectFollowUp,
  }
})

const selectedProjectChatRoute = computed(() => {
  if (!workspaceMode.value || !selected.value) return undefined
  return workspaceAgentRoute(fleet.targetId, selected.value.workspaceId, account?.teamId.value)
})

async function toggleSelectedFollowUp(): Promise<void> {
  if (!selected.value || !editorFollowUp.value) return
  const next = !editorFollowUp.value.initialEnabled
  await connectFollowUp(selected.value, next, editorFollowUp.value.initialPolicy ?? "every_run")
}

const list = () => router.replace({ name: "schedules" })
// A deleted task, or a link to another machine's task, returns to the schedules root.
watch([loaded, () => props.scheduleId, selected], () => {
  if (loaded.value && props.scheduleId && !creating.value && !selected.value) void list()
}, { immediate: true })
const save = (input: ScheduleInput, options?: { operationId?: string; scheduleId?: string }) => schedules.save(selected.value?.id, input, options)
// Replacing the creation page lets Back return to the root rather than an empty form.
function created(task: ScheduledTask): void { void router.replace({ name: "schedules", params: { scheduleId: task.id } }) }
async function remove(): Promise<void> {
  const task = removing.value
  if (!task) return
  await schedules.remove(task)
}
</script>

<template>
  <PaneHeader>
    <template v-if="scheduleId">
      <RouterLink :to="{ name: 'schedules' }" class="app-no-drag text-ui-text-muted no-underline ui-motion hover:text-ui-text">{{ t('schedules.title') }}</RouterLink>
      <span class="mx-1.5 text-ui-text-faint" aria-hidden="true">/</span>{{ creating ? t('schedules.createTitle') : selected?.title }}
    </template>
    <template v-else>{{ t('schedules.title') }}</template>
  </PaneHeader>
  <UiScrollArea class="min-h-0 flex-1" viewport-class="px-5 pb-10 pt-6 lg:px-8">
    <div v-navigation-motion="motion" class="mx-auto flex flex-col gap-5" :class="selected ? 'max-w-6xl' : 'max-w-4xl'">
      <p v-if="!online" role="status" class="ui-notice m-0 border-ui-border bg-ui-surface text-ui-text-muted">{{ t(schedules.available ? 'schedules.offline' : 'schedules.signIn') }}</p>
      <p v-if="!online && lastObservedAt" class="m-0 text-xs text-ui-text-muted">{{ t('schedules.lastObserved', { time: absoluteTime(lastObservedAt, locale) }) }}</p>
      <ErrorNotice v-if="error" :error="error">
        <UiButton type="button" :disabled="loading || pending" @click="schedules.refresh">{{ t('folderPicker.retry') }}</UiButton>
      </ErrorNotice>
      <p v-if="loading && !loaded" role="status" class="m-0 py-6 text-sm text-ui-text-muted">{{ t('schedules.loading') }}</p>

      <template v-else-if="loaded">
        <template v-if="creating">
          <h1 class="ui-page-title">{{ t('schedules.createTitle') }}</h1>
          <ScheduleEditor :disabled="blocked" :follow-up="editorFollowUp" :save="save" @saved="created" @cancel="list" />
        </template>
        <ScheduleDetail v-else-if="selected" :key="selected.id" :task="selected" :disabled="blocked" :follow-up="editorFollowUp" :project-chat-route="selectedProjectChatRoute" :save="save" @run="schedules.run(selected)" @toggle="schedules.toggle(selected)" @toggle-follow-up="toggleSelectedFollowUp" @delete="removing = selected" />
        <div v-else class="ui-empty">
          <CalendarClock :size="25" class="mb-2 text-ui-text-muted" aria-hidden="true" />
          <p class="m-0 text-sm font-medium">{{ t('schedules.title') }}</p>
          <p class="m-0 max-w-sm text-[13px] leading-5 text-ui-text-muted">{{ t('schedules.description', { machine: machineName }) }}</p>
          <RouterLink v-if="online" :to="{ name: 'schedules', params: { scheduleId: 'new' } }" data-schedule-new class="ui-button-primary mt-3 no-underline">
            <Plus :size="15" aria-hidden="true" />{{ t('schedules.create') }}
          </RouterLink>
        </div>
      </template>
    </div>
  </UiScrollArea>
  <ConfirmDialog v-if="removing" :title="t('schedules.deleteTitle', { title: removing.title })" :description="t('schedules.deleteHint')" :confirm-label="t('schedules.delete')" :confirm="remove" @close="removing = undefined" />
</template>
