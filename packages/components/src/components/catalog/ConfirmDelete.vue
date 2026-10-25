<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"

const props = defineProps<{ label: string; question: string; disabled?: boolean; remove(): Promise<void> }>()
const { t } = useI18n()
const confirming = ref(false)
const deleting = ref(false)
const error = ref<string | null>(null)
async function submit(): Promise<void> {
  if (deleting.value || props.disabled) return
  deleting.value = true
  error.value = null
  try { await props.remove(); confirming.value = false }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { deleting.value = false }
}
</script>

<template>
  <div class="flex flex-col items-start gap-2">
    <button v-if="!confirming" type="button" class="ui-button-danger" :disabled="disabled" @click="confirming = true">{{ label }}</button>
    <div v-else class="flex flex-col gap-3 rounded-xl border border-ui-danger/30 bg-ui-danger/6 p-3">
      <p class="m-0 text-sm">{{ question }}</p>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="flex gap-2">
        <button type="button" class="ui-button-danger" :disabled="deleting || disabled" @click="submit">{{ t("catalog.confirmDelete") }}</button>
        <button type="button" class="ui-button" :disabled="deleting" @click="confirming = false">{{ t("catalog.cancel") }}</button>
      </div>
    </div>
  </div>
</template>
