<script lang="ts">
import { useMediaQuery } from "@vueuse/core"
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from "reka-ui"
import { defineComponent, type PropType } from "vue"

// Preserve VNodes while forwarding the trigger slot to Reka's as-child primitive.
export default defineComponent({
  components: { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger },
  props: { text: { type: String, required: true }, disabled: Boolean, portalTo: [String, Object] as PropType<string | HTMLElement> },
  setup() {
    const touch = useMediaQuery("(max-width: 1023.9px), (hover: none)")
    return { touch }
  },
})
</script>

<template>
  <TooltipProvider :delay-duration="400" :disabled="disabled || touch">
    <TooltipRoot>
      <TooltipTrigger as-child><slot /></TooltipTrigger>
      <TooltipPortal :to="portalTo">
        <TooltipContent :side-offset="6" :collision-padding="8" class="ui-tooltip z-70 max-w-72 rounded-md border border-ui-border bg-ui-surface px-2.5 py-1.5 text-xs leading-5 text-ui-text shadow-ui-popover">
          {{ text }}
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
