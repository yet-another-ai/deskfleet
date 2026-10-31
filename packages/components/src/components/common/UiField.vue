<script setup lang="ts">
import { Eye, EyeOff } from "@lucide/vue"
import { computed, ref, useId, useSlots, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"

/**
 * Labeled native text control. `type="password"` adds the reveal toggle;
 * `#suffix` sits inside the frame, `#append` sits beside it.
 */
defineOptions({ inheritAttrs: false })
const props = defineProps<{
  label: string
  /** Native input type, ignored by the `multiline` text area. */
  type?: string
  multiline?: boolean
  readonly?: boolean
  disabled?: boolean
  /** Persistent description below the control, linked as `aria-describedby`. */
  hint?: string
}>()
const model = defineModel<string>({ default: "" })
const { t } = useI18n()
const slots = useSlots()
const id = useId()
const visible = ref(false)
const control = useTemplateRef<HTMLInputElement | HTMLTextAreaElement>("control")
// A single-line suffix reserves a fixed icon-sized inset; wider content belongs in #append.
const trailing = computed(() => !props.multiline && (props.type === "password" || !!slots.suffix))
defineExpose({ focus: () => control.value?.focus() })
</script>

<template>
  <div class="flex flex-col gap-1.5 text-sm">
    <div class="flex items-center justify-between gap-3">
      <label :for="id">{{ label }}</label>
      <slot name="aside" />
    </div>
    <div class="flex items-start gap-2">
      <div class="relative min-w-0 flex-1">
        <textarea
          v-if="multiline"
          :id="id"
          ref="control"
          v-model="model"
          v-bind="$attrs"
          class="ui-input"
          :readonly="readonly"
          :disabled="disabled"
          :aria-describedby="hint ? `${id}-hint` : undefined"
        />
        <input
          v-else
          :id="id"
          ref="control"
          v-model="model"
          v-bind="$attrs"
          class="ui-input"
          :class="{ 'pr-9': trailing }"
          :type="type === 'password' && visible ? 'text' : type"
          :readonly="readonly"
          :disabled="disabled"
          :aria-describedby="hint ? `${id}-hint` : undefined"
        >
        <div v-if="trailing" class="absolute inset-y-0 right-0 flex items-center gap-1 pr-1.5">
          <slot name="suffix" />
          <button
            v-if="type === 'password'"
            type="button"
            class="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-ui-text-muted hover:text-ui-text disabled:cursor-default disabled:op-50"
            :aria-label="t(visible ? 'common.hidePassword' : 'common.showPassword')"
            :aria-pressed="visible"
            :disabled="disabled"
            @click="visible = !visible"
          >
            <component :is="visible ? EyeOff : Eye" :size="15" :stroke-width="1.75" aria-hidden="true" />
          </button>
        </div>
      </div>
      <slot name="append" />
    </div>
    <span v-if="hint" :id="`${id}-hint`" class="text-[13px] text-ui-text-muted">{{ hint }}</span>
  </div>
</template>
