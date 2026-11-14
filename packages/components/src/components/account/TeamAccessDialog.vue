<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { DialogTitle } from "reka-ui"
import { ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import UiDialog from "../common/UiDialog.vue"

const props = defineProps<{ mode: "create" | "join" }>()
const emit = defineEmits<{ close: [] }>()
const dialog = useTemplateRef<InstanceType<typeof UiDialog>>("dialog")
const { t } = useI18n()
const session = useAccountSession()!
const value = ref("")
const pending = ref(false)
const error = ref<string>()

function close(): void { if (!pending.value) dialog.value?.close() }
async function submit(): Promise<void> {
  if (pending.value || !value.value.trim()) return
  pending.value = true
  error.value = undefined
  try {
    await (props.mode === "create" ? session.createTeam(value.value.trim()) : session.joinTeam(value.value.trim()))
    dialog.value?.close()
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pending.value = false }
}
</script>

<template>
  <UiDialog ref="dialog" class="w-[26rem]" :prevent-close="pending" @close="emit('close')">
    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <div>
        <DialogTitle class="ui-dialog-title">{{ t(mode === "create" ? "team.create" : "team.join") }}</DialogTitle>
        <p class="ui-dialog-description">{{ t(mode === "create" ? "team.createDescription" : "team.joinDescription") }}</p>
      </div>
      <label class="flex flex-col gap-1.5 text-sm">
        {{ t(mode === "create" ? "team.name" : "team.inviteCode") }}
        <input v-model="value" class="ui-input" :class="mode === 'join' && 'font-mono text-[13px]'" :name="mode === 'create' ? 'team-name' : 'invite-code'" required maxlength="256" autocomplete="off" :spellcheck="mode === 'create'" :disabled="pending" />
      </label>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="mt-2 flex justify-end gap-2">
        <UiButton type="button" :disabled="pending" @click="close">{{ t("catalog.cancel") }}</UiButton>
        <UiButton variant="primary" type="submit" :loading="pending" :disabled="pending || !value.trim()">{{ t(mode === "create" ? (pending ? "team.creating" : "team.createAction") : (pending ? "team.joining" : "team.joinAction")) }}</UiButton>
      </div>
    </form>
  </UiDialog>
</template>
