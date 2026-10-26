<script lang="ts">
import { computed, defineComponent, type Component, type PropType } from "vue"
import { useI18n } from "vue-i18n"
import { useForwardExpose } from "reka-ui"
import UiButton from "./UiButton.vue"
import UiTooltip from "./UiTooltip.vue"

// Reka's useForwardExpose needs a VDOM instance. A normal script keeps this
// composition boundary in VDOM when the application forces Vapor compilation.
export default defineComponent({
  components: { UiButton, UiTooltip },
  inheritAttrs: false,
  props: {
    icon: { type: [Object, Function] as PropType<Component>, required: true },
    label: { type: String, required: true },
    /** An unimplemented control: shown and labelled, but inert. */
    placeholder: Boolean,
    disabled: Boolean,
    portalTo: [String, Object] as PropType<string | HTMLElement>,
  },
  emits: { click: (_event: MouseEvent) => true },
  setup(props, { emit }) {
    const { forwardRef } = useForwardExpose()
    const { t } = useI18n()
    const inert = computed(() => props.placeholder || props.disabled)
    const title = computed(() => props.placeholder ? t("common.placeholderControl", { label: props.label }) : props.label)
    function click(event: MouseEvent): void { if (!inert.value) emit("click", event) }
    return { forwardRef, inert, title, click }
  },
})
</script>

<template>
  <UiTooltip :text="title" :portal-to="portalTo">
    <UiButton
      :ref="forwardRef"
      v-bind="$attrs"
      variant="ghost"
      size="icon"
      :class="inert && 'op-40 cursor-default'"
      :aria-label="title"
      :aria-disabled="inert || undefined"
      @click="click"
    >
      <component :is="icon" :size="16" :stroke-width="1.75" aria-hidden="true" />
    </UiButton>
  </UiTooltip>
</template>
