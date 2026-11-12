<script setup lang="ts">
import { ScrollAreaCorner, ScrollAreaRoot, ScrollAreaScrollbar, ScrollAreaThumb, ScrollAreaViewport } from "reka-ui"
import { computed, useTemplateRef, watchEffect, type HTMLAttributes } from "vue"
import { useScrollFade, type ScrollFadeMode, type ScrollFadeSize } from "../../composables/useScrollFade.ts"

const props = withDefaults(defineProps<{
  as?: string
  orientation?: "vertical" | "horizontal" | "both"
  fade?: ScrollFadeMode
  fadeSize?: ScrollFadeSize
  type?: "auto" | "always" | "scroll" | "hover" | "glimpse"
  focusable?: boolean
  viewportClass?: HTMLAttributes["class"]
  contentClass?: HTMLAttributes["class"]
  viewportAttrs?: Record<string, unknown>
}>(), {
  as: "div",
  orientation: "vertical",
  fade: true,
  fadeSize: "md",
  type: "auto",
  focusable: true,
})

const viewportRef = useTemplateRef<InstanceType<typeof ScrollAreaViewport>>("viewport")
const viewportElement = computed(() => viewportRef.value?.viewportElement ?? null)

const effectiveFade = computed<ScrollFadeMode>(() => {
  if (props.fade !== true) return props.fade
  if (props.orientation === "horizontal") return "x"
  if (props.orientation === "both") return "both"
  return "y"
})

const { fadeStyle, measure } = useScrollFade(viewportElement, {
  fade: effectiveFade,
  size: () => props.fadeSize,
})

watchEffect(() => {
  const el = viewportElement.value
  if (!el) return
  if (props.focusable) el.setAttribute("tabindex", "0")
  else el.removeAttribute("tabindex")
})

defineExpose({ viewportElement, measure })
</script>

<template>
  <ScrollAreaRoot
    :as="as"
    :type="type"
    data-ui-scroll-area=""
    :data-orientation="orientation"
    class="relative flex flex-col overflow-hidden"
  >
    <div class="ui-scroll-mask flex min-h-0 min-w-0 w-full flex-auto flex-col" :style="fadeStyle">
      <ScrollAreaViewport
        ref="viewport"
        as-child
        v-bind="viewportAttrs"
        class="min-h-0 min-w-0 w-full flex-auto outline-none"
        :class="viewportClass"
      >
        <div :class="contentClass">
          <slot />
        </div>
      </ScrollAreaViewport>
    </div>
    <ScrollAreaScrollbar
      v-if="orientation === 'vertical' || orientation === 'both'"
      orientation="vertical"
      class="ui-scrollbar"
    >
      <ScrollAreaThumb class="ui-scrollbar-thumb" />
    </ScrollAreaScrollbar>
    <ScrollAreaScrollbar
      v-if="orientation === 'horizontal' || orientation === 'both'"
      orientation="horizontal"
      class="ui-scrollbar"
    >
      <ScrollAreaThumb class="ui-scrollbar-thumb" />
    </ScrollAreaScrollbar>
    <ScrollAreaCorner v-if="orientation === 'both'" />
  </ScrollAreaRoot>
</template>
