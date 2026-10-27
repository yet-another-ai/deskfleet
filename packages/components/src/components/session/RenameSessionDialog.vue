<script setup lang="ts">
import { DialogTitle } from "reka-ui"
import { computed, ref, useId, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"

const props = defineProps<{ title: string; disabled?: boolean; confirm(title: string): Promise<void> }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const id = useId()
const title = ref(props.title)
const input = useTemplateRef<HTMLInputElement>("input")
const pending = ref(false)
const error = ref<string>()
const valid = computed(() => !!title.value.trim() && title.value.trim().length <= 200)

function focus(event: Event): void {
  event.preventDefault()
  input.value?.focus()
  input.value?.select()
}
async function submit(): Promise<void> {
  if (pending.value || props.disabled || !valid.value) return
  pending.value = true
  error.value = undefined
  try {
    await props.confirm(title.value.trim())
    emit("close")
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pending.value = false }
}
</script>

<template>
  <UiDialog class="w-[28rem]" :prevent-close="pending" @close="emit('close')" @open-auto-focus="focus">
    <DialogTitle class="ui-dialog-title">{{ t('agent.rename') }}</DialogTitle>
    <form class="mt-5" @submit.prevent="submit">
      <label :for="id" class="mb-2 block text-sm font-medium">{{ t('agent.sessionName') }}</label>
      <input :id="id" ref="input" v-model="title" class="ui-input w-full" type="text" maxlength="200" required :disabled="pending" :aria-invalid="!!error" :aria-describedby="error ? `${id}-error` : undefined" />
      <p v-if="error" :id="`${id}-error`" role="alert" class="mb-0 mt-3 text-sm text-ui-danger">{{ error }}</p>
      <div class="ui-dialog-actions">
        <UiButton type="button" :disabled="pending" @click="emit('close')">{{ t('catalog.cancel') }}</UiButton>
        <UiButton variant="primary" type="submit" :disabled="pending || disabled || !valid">{{ t(pending ? 'agent.renaming' : 'catalog.save') }}</UiButton>
      </div>
    </form>
  </UiDialog>
</template>
