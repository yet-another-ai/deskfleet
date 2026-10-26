<script setup lang="ts">
import UiButton from "./UiButton.vue"
import { DialogDescription, DialogTitle } from "reka-ui"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import UiDialog from "./UiDialog.vue"

const props = defineProps<{
  title: string
  description: string
  confirmLabel: string
  /** Runs the confirmed action; the dialog stays open with its error when it rejects. */
  confirm(): Promise<void>
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const pending = ref(false)
const error = ref<string>()

function cancel(): void { if (!pending.value) emit("close") }
async function submit(): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = undefined
  try {
    await props.confirm()
    emit("close")
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pending.value = false }
}
</script>

<template>
  <UiDialog class="w-[26rem]" described :prevent-close="pending" @close="cancel">
    <DialogTitle class="ui-dialog-title">{{ title }}</DialogTitle>
    <DialogDescription class="ui-dialog-description">{{ description }}</DialogDescription>
    <p v-if="error" role="alert" class="m-0 mt-4 text-sm text-ui-danger">{{ error }}</p>
    <div class="ui-dialog-actions">
      <UiButton type="button" :disabled="pending" @click="cancel">{{ t("catalog.cancel") }}</UiButton>
      <UiButton variant="danger" type="button" :disabled="pending" @click="submit">{{ confirmLabel }}</UiButton>
    </div>
  </UiDialog>
</template>
