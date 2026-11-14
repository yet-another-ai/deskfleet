<script setup lang="ts">
import UiButton from "./UiButton.vue"
import ErrorNotice from "./ErrorNotice.vue"
import { DialogDescription, DialogTitle } from "reka-ui"
import { ref, shallowRef, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import UiDialog from "./UiDialog.vue"

const props = defineProps<{
  title: string
  description: string
  confirmLabel: string
  /** Non-destructive confirmations use the primary action. */
  tone?: "danger" | "primary"
  /** Blocks confirmation while the slotted choices are incomplete. */
  confirmDisabled?: boolean
  /** Runs the confirmed action; the dialog stays open with its error when it rejects. */
  confirm(): Promise<void>
}>()
const emit = defineEmits<{ close: [] }>()
const dialog = useTemplateRef<InstanceType<typeof UiDialog>>("dialog")
const { t } = useI18n()
const pending = ref(false)
const error = shallowRef<unknown>()

function cancel(): void { if (!pending.value) dialog.value?.close() }
async function submit(): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = undefined
  try {
    await props.confirm()
    dialog.value?.close()
  } catch (reason) { error.value = reason }
  finally { pending.value = false }
}
</script>

<template>
  <UiDialog ref="dialog" class="w-[26rem]" described :prevent-close="pending" @close="emit('close')">
    <DialogTitle class="ui-dialog-title">{{ title }}</DialogTitle>
    <DialogDescription class="ui-dialog-description">{{ description }}</DialogDescription>
    <slot />
    <ErrorNotice v-if="error" :error="error" class="mt-4" />
    <div class="ui-dialog-actions">
      <UiButton type="button" data-confirm-cancel :disabled="pending" @click="cancel">{{ t("catalog.cancel") }}</UiButton>
      <UiButton :variant="tone ?? 'danger'" type="button" :disabled="pending || confirmDisabled" @click="submit">{{ confirmLabel }}</UiButton>
    </div>
  </UiDialog>
</template>
