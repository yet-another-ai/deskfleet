<script setup lang="ts">
import { DialogDescription, DialogTitle } from "reka-ui"
import { ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { TeamMember } from "@deskfleet/client/central"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"
import UiSelect from "../common/UiSelect.vue"

const props = defineProps<{ members: TeamMember[]; transfer(userId: string): Promise<void> }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const id = useId()
const userId = ref(props.members[0]?.userId ?? "")
const pending = ref(false)
const error = ref<string>()

function close(): void { if (!pending.value) emit("close") }
async function submit(): Promise<void> {
  if (pending.value || !userId.value) return
  pending.value = true
  error.value = undefined
  try { await props.transfer(userId.value); emit("close") }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pending.value = false }
}
</script>

<template>
  <UiDialog class="w-[28rem] break-words" described :prevent-close="pending" @close="close">
    <DialogTitle class="ui-dialog-title">{{ t("team.transferOwnership") }}</DialogTitle>
    <DialogDescription class="ui-dialog-description">{{ t("team.transferOwnershipDescription") }}</DialogDescription>
    <form class="mt-4" @submit.prevent="submit">
      <label :id="`${id}-owner`" class="mb-1.5 block text-[13px]">{{ t("team.newOwner") }}</label>
      <UiSelect
        v-model="userId"
        :aria-labelledby="`${id}-owner`"
        :options="members.map(member => ({ value: member.userId, label: member.email ? `${member.name} (${member.email})` : member.name }))"
        :disabled="pending"
      />
      <p v-if="error" role="alert" class="m-0 mt-4 text-sm text-ui-danger">{{ error }}</p>
      <div class="ui-dialog-actions">
        <UiButton type="button" :disabled="pending" @click="close">{{ t("catalog.cancel") }}</UiButton>
        <UiButton variant="primary" type="submit" :disabled="pending || !userId">{{ t("team.transferOwnership") }}</UiButton>
      </div>
    </form>
  </UiDialog>
</template>
