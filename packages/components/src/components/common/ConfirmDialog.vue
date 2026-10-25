<script setup lang="ts">
import { onMounted, ref, useId, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"

const props = defineProps<{
  title: string
  description: string
  confirmLabel: string
  /** Runs the confirmed action; the dialog stays open with its error when it rejects. */
  confirm(): Promise<void>
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const id = useId()
const dialog = useTemplateRef<HTMLDialogElement>("dialog")
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
onMounted(() => dialog.value?.showModal())
</script>

<template>
  <dialog ref="dialog" class="ui-dialog app-no-drag w-[26rem]" :aria-labelledby="`${id}-title`" :aria-describedby="`${id}-description`" @cancel.prevent="cancel">
    <h2 :id="`${id}-title`" class="m-0 mb-2 text-base font-semibold">{{ title }}</h2>
    <p :id="`${id}-description`" class="m-0 mb-4 text-sm text-ui-text-muted">{{ description }}</p>
    <p v-if="error" role="alert" class="m-0 mb-4 text-sm text-ui-danger">{{ error }}</p>
    <div class="flex justify-end gap-2">
      <button type="button" class="catalog-button" :disabled="pending" @click="cancel">{{ t("catalog.cancel") }}</button>
      <button type="button" class="catalog-button text-ui-danger" :disabled="pending" @click="submit">{{ confirmLabel }}</button>
    </div>
  </dialog>
</template>
