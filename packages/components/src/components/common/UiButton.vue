<script lang="ts">
import { LoaderCircle } from "@lucide/vue"
import { useForwardExpose } from "reka-ui"
import { computed, defineComponent, type PropType } from "vue"
import { i18n } from "../../i18n/index.ts"
import UiTooltip from "./UiTooltip.vue"

// Reka as-child and useForwardExpose need a VDOM boundary when Vapor is enabled.
export default defineComponent({
  components: { LoaderCircle, UiTooltip },
  inheritAttrs: false,
  props: {
    variant: { type: String as PropType<"default" | "primary" | "danger" | "ghost">, default: "default" },
    size: { type: String as PropType<"default" | "sm" | "icon">, default: "default" },
    type: { type: String as PropType<"button" | "submit" | "reset">, default: "button" },
    label: String,
    /** An unimplemented control: shown and labelled, but inert. */
    placeholder: Boolean,
    disabled: Boolean,
    loading: Boolean,
    portalTo: [String, Object] as PropType<string | HTMLElement>,
  },
  emits: { click: (_event: MouseEvent) => true },
  setup(props, { emit }) {
    const { forwardRef } = useForwardExpose()
    const { t } = i18n.global
    const inert = computed(() => props.placeholder || props.disabled || props.loading)
    const title = computed(() => {
      if (!props.label) return undefined
      return props.placeholder ? t("common.placeholderControl", { label: props.label }) : props.label
    })
    function click(event: MouseEvent): void {
      if (inert.value) {
        event.preventDefault()
        return
      }
      emit("click", event)
    }
    return {
      forwardRef,
      inert,
      title,
      click,
      variants: { default: "ui-button", primary: "ui-button-primary", danger: "ui-button-danger", ghost: "ui-button-ghost" },
      sizes: { default: "h-8 px-3", sm: "h-7 px-2", icon: "h-7 w-7 shrink-0 p-0" },
    }
  },
})
</script>

<template>
  <UiTooltip v-if="title" :text="title" :portal-to="portalTo">
    <button
      :ref="forwardRef"
      v-bind="$attrs"
      :type="type"
      :class="[variants[variant], sizes[size], inert && 'op-40 cursor-default']"
      :aria-label="title"
      :aria-disabled="inert || undefined"
      :aria-busy="loading || undefined"
      @click="click"
    >
      <LoaderCircle v-if="loading" :size="14" class="shrink-0 animate-spin" aria-hidden="true" />
      <slot />
    </button>
  </UiTooltip>
  <button
    v-else
    :ref="forwardRef"
    v-bind="$attrs"
    :type="type"
    :class="[variants[variant], sizes[size]]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
    @click="click"
  >
    <LoaderCircle v-if="loading" :size="14" class="shrink-0 animate-spin" aria-hidden="true" />
    <slot />
  </button>
</template>
