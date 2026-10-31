<script setup lang="ts">
import UiButton from "./UiButton.vue"
import UiField from "./UiField.vue"
import { Check, Copy } from "@lucide/vue"
import { useTimeoutFn } from "@vueuse/core"
import { ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"

const props = defineProps<{
  label: string
  value: string
  /** Multi-line values such as credentials render as a read-only text area. */
  multiline?: boolean
}>()
const { t } = useI18n()
const copied = ref(false)
const field = useTemplateRef<InstanceType<typeof UiField>>("field")
const { start: resetCopied } = useTimeoutFn(() => { copied.value = false }, 2000, { immediate: false })

async function copy(): Promise<void> {
  try { await navigator.clipboard.writeText(props.value) } catch { return }
  copied.value = true
  resetCopied()
}
const selectAll = (event: FocusEvent) => (event.target as HTMLInputElement | HTMLTextAreaElement).select()
defineExpose({ focus: () => field.value?.focus() })
</script>

<template>
  <UiField
    ref="field"
    :label="label"
    :model-value="value"
    readonly
    :multiline="multiline"
    class="font-mono text-xs"
    :class="multiline && 'h-28 resize-none'"
    @focus="selectAll"
  >
    <template #append>
      <UiButton type="button" class="shrink-0" :aria-label="t('common.copyLabel', { label })" @click="copy">
        <component :is="copied ? Check : Copy" :size="14" :stroke-width="1.75" aria-hidden="true" />
        {{ copied ? t("common.copied") : t("common.copy") }}
      </UiButton>
    </template>
  </UiField>
</template>
