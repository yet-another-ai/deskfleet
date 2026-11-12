<script setup lang="ts">
import { useResizeObserver } from "@vueuse/core"
import { CollapsibleContent, injectCollapsibleRootContext } from "reka-ui"
import { computed, nextTick, ref, useTemplateRef, watch } from "vue"
import { useSpring } from "../../composables/useSpring.ts"

defineOptions({ inheritAttrs: false })
const context = injectCollapsibleRootContext()
const content = useTemplateRef<HTMLElement>("content")
const mounted = ref(context.open.value)
const initializeOpenHeight = ref(context.open.value)
const height = useSpring(0, { min: 0 })
const settledOpen = computed(() => context.open.value && (initializeOpenHeight.value || (!height.isActive.value && height.target.value > 0)))
function measure(): void {
  if (!context.open.value || !content.value) return
  const measured = content.value.getBoundingClientRect().height
  if (initializeOpenHeight.value) {
    // Restored open content already occupies its natural height on mount.
    height.jump(measured)
    initializeOpenHeight.value = false
  } else height.setTarget(measured)
}
watch(context.open, async open => {
  if (open) { mounted.value = true; await nextTick(); measure() }
  else {
    initializeOpenHeight.value = false
    height.setTarget(0)
    if (!height.isActive.value) mounted.value = false
  }
}, { immediate: true })
watch(height.isActive, active => { if (!active && !context.open.value) mounted.value = false })
useResizeObserver(content, measure)
</script>

<template>
  <CollapsibleContent force-mount class="ui-collapsible" :hidden="!mounted" :inert="!context.open.value" :style="{ height: settledOpen ? 'auto' : `${height.position.value}px` }">
    <div v-if="mounted" ref="content" v-bind="$attrs" class="flow-root"><slot /></div>
  </CollapsibleContent>
</template>
