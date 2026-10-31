<script setup lang="ts">
import UiButton from "./UiButton.vue"
import ErrorNotice from "./ErrorNotice.vue"
import { DialogDescription, DialogTitle } from "reka-ui"
import { ref, shallowRef } from "vue"
import { useI18n } from "vue-i18n"
import UiDialog from "./UiDialog.vue"

const props = defineProps<{
  title: string
  description: string
  confirmLabel: string
  /** Non-destructive confirmations use the primary action. */
  tone?: "danger" | "primary"
  /** Runs the confirmed action; the dialog stays open with its error when it rejects. */
  confirm(): Promise<void>
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const pending = ref(false)
const error = shallowRef<unknown>()

function cancel(): void { if (!pending.value) emit("close") }
async function submit(): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = undefined
  try {
    await props.confirm()
    emit("close")
  } catch (reason) { error.value = reason }
  finally { pending.value = false }
}
</script>

<template>
  <UiDialog class="w-[26rem]" described :prevent-close="pending" @close="cancel">
    <DialogTitle class="ui-dialog-title">{{ title }}</DialogTitle>
    <DialogDescription class="ui-dialog-description">{{ description }}</DialogDescription>
    <ErrorNotice v-if="error" :error="error" class="mt-4" />
    <div class="ui-dialog-actions">
      <UiButton type="button" :disabled="pending" @click="cancel">{{ t("catalog.cancel") }}</UiButton>
      <UiButton :variant="tone ?? 'danger'" type="button" :disabled="pending" @click="submit">{{ confirmLabel }}</UiButton>
    </div>
  </UiDialog>
</template>
