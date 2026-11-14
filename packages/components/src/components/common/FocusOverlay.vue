<script setup lang="ts" generic="T">
import { nextTick, onUnmounted, shallowRef, watch } from "vue"
import { useSpring } from "../../composables/useSpring.ts"

defineOptions({ inheritAttrs: false })
// A callback also runs during parent Vapor teardown, when component emits are
// already disabled. It must run after removal for source-location DOM queries.
const props = defineProps<{ content?: T; onAfterLeave?: () => void }>()
const present = shallowRef<T>()
const opacity = useSpring(0, { positionThreshold: 0.001, velocityThreshold: 0.005 })
let pendingLeave = false
let disposed = false

// Keep the complete preview descriptor while its route query is being cleared.
// Reopening changes the same spring's target without replacing its live content.
watch(() => props.content, content => {
  if (content !== undefined) {
    pendingLeave = false
    present.value = content
  }
  opacity.setTarget(content === undefined ? 0 : 1)
}, { immediate: true, flush: "sync" })
watch([() => props.content, opacity.isActive], async ([content, active]) => {
  if (content !== undefined || active || present.value === undefined) return
  present.value = undefined
  pendingLeave = true
  await nextTick()
  if (disposed || !pendingLeave) return
  pendingLeave = false
  props.onAfterLeave?.()
})
onUnmounted(() => {
  disposed = true
  if (present.value !== undefined || pendingLeave) props.onAfterLeave?.()
})
</script>

<template>
  <div v-if="present !== undefined" v-bind="$attrs" :inert="content === undefined" :aria-hidden="content === undefined || undefined" :style="{ opacity: Math.max(0, Math.min(1, opacity.position.value)) }">
    <slot :content="present" />
  </div>
</template>
