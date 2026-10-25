<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { ProductDemoOptions } from "./product-demo-runtime.ts"

const props = withDefaults(defineProps<ProductDemoOptions>(), { chinese: false, sidebar: undefined, details: undefined })
const target = ref<HTMLElement>()
let dispose: (() => void) | undefined
let generation = 0
async function mount() {
  const current = ++generation
  dispose?.()
  dispose = undefined
  const { mountProductDemo } = await import("./product-demo-runtime.ts")
  if (!target.value || current !== generation) return
  const cleanup = await mountProductDemo(target.value, { ...props })
  if (current !== generation) cleanup()
  else dispose = cleanup
}
onMounted(mount)
watch(() => [props.chinese, props.kind, props.initialRoute, props.sidebar, props.details], mount)
onBeforeUnmount(() => { generation++; dispose?.() })
</script>

<template><div ref="target" class="vp-raw product-demo actual-product-demo" /></template>

<style scoped>
.actual-product-demo { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: auto; background: var(--ui-color-canvas); }
/* Small embeds scroll a normal application window instead of compressing its controls. */
.actual-product-demo > :deep(div) { min-height: 480px; }
</style>
