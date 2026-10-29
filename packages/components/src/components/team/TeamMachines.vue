<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { Monitor, Pencil, Plus, Trash2 } from "@lucide/vue"
import { computed, nextTick, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { Machine } from "@deskfleet/client/central"
import { intlLocale, type AppLocale } from "../../../../client/src/i18n.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import IconButton from "../common/IconButton.vue"

const { t, locale } = useI18n()
const id = useId()
const session = useAccountSession()!
const admin = computed(() => session.team.value?.role === "owner" || session.team.value?.role === "admin")
const removing = ref<Machine>()
// Every member can rename a machine; only one is edited at a time.
const editing = ref<string>()
const name = ref("")
const saving = ref(false)
const renameError = ref<string>()
let nameInput: HTMLInputElement | null = null
const setNameInput = (element: unknown) => { nameInput = element instanceof HTMLInputElement ? element : null }

function status(machine: Machine): string {
  if (machine.online) return t("machine.online")
  if (!machine.lastSeenAt) return t("team.neverConnected")
  const time = new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), { dateStyle: "medium", timeStyle: "short" }).format(new Date(machine.lastSeenAt))
  return t("machine.lastSeen", { time })
}
async function focusRenameButton(machineId: string): Promise<void> {
  await nextTick()
  document.querySelector<HTMLElement>(`[data-rename-machine="${machineId}"]`)?.focus()
}
async function startRename(machine: Machine): Promise<void> {
  editing.value = machine.id
  name.value = machine.name
  renameError.value = undefined
  await nextTick()
  nameInput?.focus()
  nameInput?.select()
}
function cancelRename(): void {
  if (saving.value || !editing.value) return
  const machineId = editing.value
  editing.value = undefined
  renameError.value = undefined
  void focusRenameButton(machineId)
}
async function rename(machine: Machine): Promise<void> {
  const value = name.value.trim()
  if (saving.value || !value) return
  if (value === machine.name) { cancelRename(); return }
  saving.value = true
  renameError.value = undefined
  try {
    await session.renameMachine(machine.id, value)
    editing.value = undefined
    void focusRenameButton(machine.id)
  } catch (reason) { renameError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { saving.value = false }
}
</script>

<template>
  <section :aria-labelledby="`${id}-title`">
    <div class="ui-section-header">
      <h2 :id="`${id}-title`" class="ui-section-title">
        {{ t("team.machines") }}<span class="ml-1.5 text-ui-text-faint">{{ session.machines.value.length }}</span>
      </h2>
      <UiButton type="button" class="shrink-0" @click="session.dialog.value = 'add-machine'">
        <Plus :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("account.addMachine") }}
      </UiButton>
    </div>
    <ul v-if="session.machines.value.length" class="ui-card m-0 list-none p-0 shadow-ui-card">
      <li v-for="(machine, index) in session.machines.value" :key="machine.id" class="flex items-center gap-3 px-4 py-3" :class="index > 0 && 'border-t border-ui-border'" :data-team-machine-id="machine.id">
        <span class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ui-badge text-ui-text-muted" aria-hidden="true">
          <Monitor :size="16" :stroke-width="1.75" />
          <span class="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-ui-surface" :class="machine.online ? 'bg-ui-success' : 'bg-ui-text-faint'" />
        </span>
        <!-- Escape cancels the edit without leaving Settings. -->
        <form v-if="editing === machine.id" class="flex min-w-0 flex-1 items-center gap-2" @submit.prevent="rename(machine)" @keydown.esc.stop.prevent="cancelRename">
          <input
            :ref="setNameInput"
            v-model="name"
            name="machine-name"
            class="ui-input py-1 text-sm"
            :aria-label="t('team.machineNameFor', { name: machine.name })"
            required
            maxlength="200"
            autocomplete="off"
            :disabled="saving"
          />
          <UiButton type="submit" class="shrink-0" :disabled="saving || !name.trim()">{{ saving ? t("catalog.saving") : t("catalog.save") }}</UiButton>
          <UiButton type="button" class="shrink-0" :disabled="saving" @click="cancelRename">{{ t("catalog.cancel") }}</UiButton>
        </form>
        <template v-else>
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-1.5 text-sm">
              <span class="truncate">{{ machine.name }}</span>
              <span v-if="machine.id === session.localMachineId.value" class="ui-badge shrink-0">{{ t("account.thisComputer") }}</span>
            </div>
            <div class="truncate text-[13px] text-ui-text-muted">{{ status(machine) }}</div>
          </div>
          <IconButton :icon="Pencil" :label="t('team.renameMachineLabel', { name: machine.name })" :data-rename-machine="machine.id" :disabled="!!editing" @click="startRename(machine)" />
          <IconButton v-if="admin" :icon="Trash2" :label="t('team.removeMachineLabel', { name: machine.name })" :disabled="!!editing" @click="removing = machine" />
        </template>
      </li>
    </ul>
    <div v-else class="ui-empty">
      <p class="m-0 text-sm">{{ t("team.noMachines") }}</p>
      <p class="m-0 max-w-sm text-[13px] text-ui-text-muted">{{ t("team.noMachinesDescription") }}</p>
    </div>
    <p v-if="renameError" role="alert" class="m-0 mt-2 text-sm text-ui-danger">{{ renameError }}</p>
  </section>
  <ConfirmDialog
    v-if="removing"
    :title="t('team.removeMachineTitle', { name: removing.name })"
    :description="t('team.removeMachineDescription')"
    :confirm-label="t('team.remove')"
    :confirm="() => session.removeMachine(removing!.id)"
    @close="removing = undefined"
  />
</template>
