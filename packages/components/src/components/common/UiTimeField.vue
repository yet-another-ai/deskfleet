<script setup lang="ts">
import { Clock3 } from "@lucide/vue"
import { Time } from "@internationalized/date"
import { TimeFieldInput, TimeFieldRoot, type TimeValue } from "reka-ui"
import { computed } from "vue"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
const props = defineProps<{ modelValue: string; name?: string; required?: boolean; disabled?: boolean; locale?: string }>()
const emit = defineEmits<{ "update:modelValue": [value: string] }>()
const value = computed(() => {
  const parts = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/u.exec(props.modelValue)
  return parts ? new Time(Number(parts[1]), Number(parts[2])) : null
})
function update(time: TimeValue | undefined): void {
  emit("update:modelValue", time ? `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}` : "")
}
</script>

<template>
  <TimeFieldRoot v-slot="{ segments }" :model-value="value" :locale="locale ? intlLocale(locale as AppLocale) : undefined" :hour-cycle="24" granularity="minute" :required="required" :disabled="disabled" class="ui-input inline-flex w-auto items-center gap-0.5 text-sm tabular-nums focus-within:border-ui-accent data-[disabled]:op-50" :data-control-name="name" @update:model-value="update">
    <Clock3 :size="15" class="mr-1.5 shrink-0 text-ui-text-muted" aria-hidden="true" />
    <TimeFieldInput v-for="segment in segments" :key="segment.part" :part="segment.part" class="rounded px-0.5 focus:bg-ui-accent/15 focus:outline-none data-[placeholder]:text-ui-text-faint">{{ segment.value }}</TimeFieldInput>
    <input v-if="name" type="hidden" :name="name" :value="modelValue" :disabled="disabled" />
  </TimeFieldRoot>
</template>
