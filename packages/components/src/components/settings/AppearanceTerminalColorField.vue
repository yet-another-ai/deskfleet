<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { TerminalColorKey } from "@deskfleet/client/terminal-theme"

const props = defineProps<{ colorKey: TerminalColorKey; modelValue: string; disabled?: boolean }>()
const emit = defineEmits<{ "update:modelValue": [value: string] }>()
const { t } = useI18n()
const draft = ref(props.modelValue)
const invalid = ref(false)
const id = computed(() => `appearance-terminal-color-${props.colorKey}`)
const swatch = computed(() => /^#[\da-f]{6}$/i.test(draft.value) ? draft.value : props.modelValue)
watch(() => props.modelValue, value => { draft.value = value; invalid.value = false })

function commit(): void {
  const value = `#${draft.value.trim().replace(/^#/, "")}`.toLowerCase()
  invalid.value = !/^#[\da-f]{6}$/i.test(value)
  if (invalid.value) return
  draft.value = value
  if (value !== props.modelValue.toLowerCase()) emit("update:modelValue", value)
}
</script>

<template>
  <div class="min-w-0">
    <label :id="`${id}-label`" :for="`${id}-hex`" class="mb-1.5 block text-xs text-ui-text-muted">{{ t(`appearance.terminalColorLabels.${colorKey}`) }}</label>
    <div class="flex items-center gap-2">
      <input
        :id="id" type="color" :value="swatch" :disabled="disabled" :aria-labelledby="`${id}-label`"
        class="color-swatch h-8 w-9 shrink-0 cursor-pointer rounded-md border border-ui-border bg-ui-surface p-1 disabled:cursor-default disabled:op-50"
        @input="draft = ($event.target as HTMLInputElement).value" @change="commit"
      >
      <input
        :id="`${id}-hex`" v-model="draft" type="text" :disabled="disabled" :aria-invalid="invalid || undefined"
        :aria-describedby="invalid ? `${id}-error` : undefined" spellcheck="false" autocomplete="off" maxlength="7"
        class="ui-input min-w-0 w-full font-mono text-xs" @input="invalid = false" @change="commit" @keydown.enter.prevent="commit"
      >
    </div>
    <p v-if="invalid" :id="`${id}-error`" role="alert" class="mb-0 mt-1 text-xs text-ui-danger">{{ t("appearance.invalidTerminalColor") }}</p>
  </div>
</template>

<style scoped>
.color-swatch::-webkit-color-swatch-wrapper { padding: 0; }
.color-swatch::-webkit-color-swatch { border: 0; border-radius: 3px; }
.color-swatch::-moz-color-swatch { border: 0; border-radius: 3px; }
</style>
