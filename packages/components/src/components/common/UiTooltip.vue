<script lang="ts">
import { useMediaQuery } from "@vueuse/core"
import { vSpringEnter } from "../../directives/spring.ts"
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from "reka-ui"
import { defineComponent, type PropType } from "vue"

// Preserve VNodes while forwarding the trigger slot to Reka's as-child primitive.
export default defineComponent({
  directives: { springEnter: vSpringEnter },
  components: { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger },
  props: { text: { type: String, required: true }, portalTo: [String, Object] as PropType<string | HTMLElement> },
  setup() {
    const disabled = useMediaQuery("(max-width: 1023.9px), (hover: none)")
    return { disabled }
  },
})
</script>

<template>
  <TooltipProvider :delay-duration="400" :disabled="disabled">
    <TooltipRoot>
      <TooltipTrigger as-child><slot /></TooltipTrigger>
      <TooltipPortal :to="portalTo">
        <TooltipContent as-child :side-offset="6" :collision-padding="8" class="ui-tooltip z-70 max-w-72 rounded-md border border-ui-border bg-ui-surface px-2.5 py-1.5 text-xs leading-5 text-ui-text shadow-ui-popover"><div v-spring-enter>
          {{ text }}
        </div></TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
