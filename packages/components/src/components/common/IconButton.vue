<script setup lang="ts">
import { computed, type Component } from "vue"
import { useI18n } from "vue-i18n"

const props = defineProps<{
  icon: Component
  label: string
  /** An unimplemented control: shown and labelled, but inert. */
  placeholder?: boolean
  disabled?: boolean
}>()
const emit = defineEmits<{ click: [] }>()
const { t } = useI18n()

const inert = computed(() => props.placeholder || props.disabled)
const title = computed(() =>
  props.placeholder ? t("common.placeholderControl", { label: props.label }) : props.label,
)

function click(): void {
  if (!inert.value) emit("click")
}
</script>

<template>
  <button
    type="button"
    class="app-no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ui-text-muted"
    :class="
      disabled
        ? 'op-40 cursor-default'
        : placeholder
          ? 'cursor-default'
          : 'cursor-pointer hover:bg-ui-hover hover:text-ui-text'
    "
    :title="title"
    :aria-label="title"
    :aria-disabled="inert || undefined"
    @click="click"
  >
    <component :is="icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
  </button>
</template>
