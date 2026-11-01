<script setup lang="ts">
import { useElementByPoint, useEventListener, useMediaQuery, useMouse, usePreferredReducedMotion } from "@vueuse/core"
import { computed, ref, watch } from "vue"
import {
  findReadingSurface, findSpotlightBlock, padSpotlightRect, spotlightRectForBlock,
} from "../../services/reading-spotlight.ts"
import { useAppearanceStore } from "../../stores/appearance.ts"

const appearance = useAppearanceStore()
const finePointer = useMediaQuery("(pointer: fine)")
const reducedMotion = usePreferredReducedMotion()
const active = computed(() => appearance.settings.readingSpotlight && finePointer.value)

const { x, y } = useMouse({ type: "client", touch: false })
const { element, pause, resume } = useElementByPoint({ x, y })
const box = ref<Record<string, string>>({ display: "none" })

function clear(): void {
  box.value = { display: "none" }
}

function update(): void {
  if (!active.value) {
    clear()
    return
  }
  const under = element.value
  const surface = findReadingSurface(under)
  if (!surface) {
    clear()
    return
  }
  const block = findSpotlightBlock(under, surface, y.value)
  if (!block) {
    clear()
    return
  }
  const rect = padSpotlightRect(spotlightRectForBlock(block, y.value))
  if (rect.width <= 0 || rect.height <= 0) {
    clear()
    return
  }
  box.value = {
    display: "block",
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    transition: reducedMotion.value === "reduce" ? "none" : "all 0.15s ease",
  }
}

watch(active, enabled => {
  if (enabled) {
    resume()
    update()
  } else {
    pause()
    clear()
  }
}, { immediate: true })

watch([x, y, element], () => { if (active.value) update() })
useEventListener("scroll", () => { if (active.value) update() }, true)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="active"
      v-show="box.display === 'block'"
      class="ui-reading-spotlight"
      :style="box"
      aria-hidden="true"
      data-reading-spotlight
    />
  </Teleport>
</template>
