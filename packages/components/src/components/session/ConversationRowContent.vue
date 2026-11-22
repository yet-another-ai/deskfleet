<script lang="ts">
import { computed, defineComponent, onBeforeUnmount, ref, useTemplateRef, watch, type PropType } from "vue"
import type { useConversationViewport } from "../../composables/useConversationViewport.ts"

// Keep this slot boundary in Vue's VDOM renderer. With Vapor in Vue 3.6 RC, the
// removed slot's subscriptions retain detached Markdown trees after recycling.
export default defineComponent({
  props: {
    observe: Function as PropType<ReturnType<typeof useConversationViewport>["observe"]>,
    heights: { type: Map as PropType<Map<string, number>>, required: true },
    rowId: { type: String, required: true },
    estimate: { type: Number, required: true },
    eager: Boolean,
    pinned: Boolean,
  },
  setup(props) {
    const row = useTemplateRef<HTMLElement>("row")
    const nearby = ref(props.eager)
    const focused = ref(false)
    const rendered = computed(() => !props.observe || props.pinned || nearby.value || focused.value)
    const height = computed(() => rendered.value ? undefined : `${props.heights.get(props.rowId) ?? props.estimate}px`)

    function rememberHeight() {
      const measured = row.value?.getBoundingClientRect().height
      if (measured) props.heights.set(props.rowId, measured)
    }
    // Measure the real row before replacing its children with the spacer.
    watch(rendered, show => { if (!show) rememberHeight() }, { flush: "pre" })
    watch([row, () => props.observe], ([element, observe], _, onCleanup) => {
      if (element && observe) onCleanup(observe(element, visible => { nearby.value = visible }))
    }, { flush: "post", immediate: true })
    onBeforeUnmount(() => { if (rendered.value) rememberHeight() })

    function onFocusOut(event: FocusEvent) {
      focused.value = event.relatedTarget instanceof Node && !!row.value?.contains(event.relatedTarget)
    }
    return { focused, height, rendered, onFocusOut }
  },
})
</script>

<template>
  <div ref="row" :style="{ height }" @focusin="focused = true" @focusout="onFocusOut">
    <slot v-if="rendered" />
  </div>
</template>
