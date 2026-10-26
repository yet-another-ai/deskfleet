<script setup lang="ts">
import UiButton from "./UiButton.vue"
import { Check, Copy } from "@lucide/vue"
import { useTimeoutFn } from "@vueuse/core"
import { ref, useId } from "vue"
import { useI18n } from "vue-i18n"

const props = defineProps<{
  label: string
  value: string
  /** Multi-line values such as credentials render as a read-only text area. */
  multiline?: boolean
}>()
const { t } = useI18n()
const id = useId()
const copied = ref(false)
const { start: resetCopied } = useTimeoutFn(() => { copied.value = false }, 2000, { immediate: false })

async function copy(): Promise<void> {
  try { await navigator.clipboard.writeText(props.value) } catch { return }
  copied.value = true
  resetCopied()
}
const selectAll = (event: FocusEvent) => (event.target as HTMLInputElement | HTMLTextAreaElement).select()
defineExpose({ focus: () => (document.getElementById(id) as HTMLElement | null)?.focus() })
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label :for="id" class="text-[13px] text-ui-text-muted">{{ label }}</label>
    <div class="flex items-start gap-2">
      <textarea v-if="multiline" :id="id" readonly class="ui-input h-28 resize-none font-mono text-xs" :value="value" :spellcheck="false" @focus="selectAll" />
      <input v-else :id="id" readonly class="ui-input font-mono text-xs" :value="value" :spellcheck="false" @focus="selectAll" />
      <UiButton type="button" class="shrink-0" :aria-label="t('common.copyLabel', { label })" @click="copy">
        <component :is="copied ? Check : Copy" :size="14" :stroke-width="1.75" aria-hidden="true" />
        {{ copied ? t("common.copied") : t("common.copy") }}
      </UiButton>
    </div>
  </div>
</template>
