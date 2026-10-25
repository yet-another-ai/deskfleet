<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import ProductDemo from "../demos/ProductDemo.vue"

withDefaults(defineProps<{
  kind: "agents" | "team" | "session"
  initialRoute: string
  chinese?: boolean
}>(), { chinese: false })

// The application renders at its normal desktop size. Only the presentation
// layer scales it into a hero slot; the product components stay unchanged.
const width = 1280
const height = 800
const target = ref<HTMLElement>()
const scale = ref(0.3)
const frameStyle = computed(() => ({ width: `${width * scale.value}px`, height: `${height * scale.value}px` }))
const contentStyle = computed(() => ({ width: `${width}px`, height: `${height}px`, transform: `scale(${scale.value})` }))
let observer: ResizeObserver | undefined

onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (entry) scale.value = Math.min(entry.contentRect.width / width, entry.contentRect.height / height)
  })
  if (target.value) observer.observe(target.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div ref="target" class="app-window">
    <div class="app-window__frame" :style="frameStyle">
      <div class="app-window__content" :style="contentStyle">
        <ProductDemo :kind="kind" :initial-route="initialRoute" :chinese="chinese" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-window {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
}

.app-window__frame {
  position: relative;
  flex: none;
  overflow: hidden;
  border: 1px solid var(--ui-color-border);
  border-radius: 8px;
  background: var(--ui-color-canvas);
  box-shadow: 0 24px 42px -16px var(--home-shadow), 0 3px 10px -2px var(--home-shadow-near);
}

.app-window__content {
  transform-origin: top left;
}
</style>
