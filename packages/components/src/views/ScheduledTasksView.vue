<script setup lang="ts">
import { CalendarClock, Plus, RefreshCw } from "@lucide/vue"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink, useRouter } from "vue-router"
import type { ScheduleInput, ScheduledTask } from "@deskfleet/client/schedules"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import ConfirmDialog from "../components/common/ConfirmDialog.vue"
import ScheduleDetail from "../components/schedules/ScheduleDetail.vue"
import ScheduleEditor from "../components/schedules/ScheduleEditor.vue"
import ScheduleList from "../components/schedules/ScheduleList.vue"
import { useScheduledTasks } from "../composables/useScheduledTasks.ts"
import { useFleetStore } from "../stores/fleet.ts"

// `/schedules` lists the machine's tasks, `/schedules/new` creates one, and `/schedules/:id` shows one.
const props = defineProps<{ scheduleId?: string }>()
const { t } = useI18n()
const router = useRouter()
const fleet = useFleetStore()
const schedules = useScheduledTasks()
const { account, online, tasks, loaded, loading, pending, error } = schedules
const creating = computed(() => props.scheduleId === "new")
const selected = computed(() => props.scheduleId && !creating.value ? tasks.value.find(task => task.id === props.scheduleId) : undefined)
const machineName = computed(() => account?.machine.value?.name ?? fleet.machines[0]?.name)
const blocked = computed(() => !online.value || pending.value)
const removing = ref<ScheduledTask>()

const list = () => router.replace({ name: "schedules" })
// A deleted task, or a link to another machine's task, returns to the list.
watch([loaded, () => props.scheduleId, selected], () => {
  if (loaded.value && props.scheduleId && !creating.value && !selected.value) void list()
}, { immediate: true })
const save = (input: ScheduleInput) => schedules.save(selected.value?.id, input)
// Replacing the creation page lets Back return to the list rather than an empty form.
function created(task: ScheduledTask): void { void router.replace({ name: "schedules", params: { scheduleId: task.id } }) }
async function remove(): Promise<void> {
  const task = removing.value
  if (!task) return
  await schedules.remove(task)
}
</script>

<template>
  <PaneHeader hide-details>
    <template v-if="scheduleId">
      <RouterLink :to="{ name: 'schedules' }" class="app-no-drag text-ui-text-muted no-underline hover:text-ui-text">{{ t('schedules.title') }}</RouterLink>
      <span class="mx-1.5 text-ui-text-faint" aria-hidden="true">/</span>{{ creating ? t('schedules.createTitle') : selected?.title }}
    </template>
    <template v-else>{{ t('schedules.title') }}</template>
  </PaneHeader>
  <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-6 lg:px-8">
    <div class="mx-auto flex flex-col gap-5" :class="selected ? 'max-w-6xl' : 'max-w-4xl'">
      <template v-if="!scheduleId">
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div class="min-w-0">
            <h1 class="ui-page-title">{{ t('schedules.title') }}</h1>
            <p class="m-0 mt-1 text-sm text-ui-text-muted">{{ t('schedules.description', { machine: machineName }) }}</p>
          </div>
          <div class="flex items-center gap-2">
            <select v-if="account && account.machines.value.length > 1" class="ui-input w-auto max-w-48 text-[13px]" name="schedule-machine" :aria-label="t('schedules.machine')" :value="fleet.targetId" :disabled="pending" @change="account.selectMachine(($event.target as HTMLSelectElement).value)">
              <option v-for="machine in account.machines.value" :key="machine.id" :value="machine.id">{{ machine.name }}</option>
            </select>
            <button type="button" class="ui-button px-2" :aria-label="t('catalog.refresh')" :title="t('catalog.refresh')" :disabled="!online || loading || pending" @click="schedules.refresh"><RefreshCw :size="14" aria-hidden="true" /></button>
            <RouterLink v-if="online && loaded" :to="{ name: 'schedules', params: { scheduleId: 'new' } }" data-schedule-new class="ui-button-primary no-underline"><Plus :size="15" aria-hidden="true" />{{ t('schedules.create') }}</RouterLink>
          </div>
        </div>
      </template>

      <p v-if="!online" role="status" class="ui-notice m-0 border-ui-border bg-ui-surface text-ui-text-muted">{{ t(schedules.available ? 'schedules.offline' : 'schedules.signIn') }}</p>
      <div v-if="error" class="ui-notice m-0 justify-between border-ui-danger/30 bg-ui-danger/8">
        <p role="alert" class="m-0 text-ui-danger">{{ error }}</p>
        <button v-if="!loaded" type="button" class="ui-button" :disabled="!online || loading" @click="schedules.refresh">{{ t('folderPicker.retry') }}</button>
      </div>
      <p v-if="loading && !loaded" role="status" class="m-0 py-6 text-sm text-ui-text-muted">{{ t('schedules.loading') }}</p>

      <template v-else-if="loaded">
        <template v-if="creating">
          <h1 class="ui-page-title">{{ t('schedules.createTitle') }}</h1>
          <ScheduleEditor :disabled="blocked" :save="save" @saved="created" @cancel="list" />
        </template>
        <ScheduleDetail v-else-if="selected" :key="selected.id" :task="selected" :disabled="blocked" :save="save" @run="schedules.run(selected)" @toggle="schedules.toggle(selected)" @delete="removing = selected" />
        <template v-else-if="!scheduleId">
          <div v-if="!tasks.length" class="ui-empty">
            <CalendarClock :size="25" class="mb-2 text-ui-text-muted" aria-hidden="true" />
            <p class="m-0 text-sm font-medium">{{ t('schedules.empty') }}</p>
            <p class="m-0 max-w-sm text-[13px] leading-5 text-ui-text-muted">{{ t('schedules.emptyHint') }}</p>
          </div>
          <ScheduleList v-else :tasks="tasks" :disabled="blocked" @run="schedules.run" @toggle="schedules.toggle" />
        </template>
      </template>
    </div>
  </div>
  <ConfirmDialog v-if="removing" :title="t('schedules.deleteTitle', { title: removing.title })" :description="t('schedules.deleteHint')" :confirm-label="t('schedules.delete')" :confirm="remove" @close="removing = undefined" />
</template>
