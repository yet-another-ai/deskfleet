<script lang="ts">
import { LoaderCircle } from "@lucide/vue"
import { defineComponent, type PropType } from "vue"

// Reka as-child clones VNodes, so its button target stays on the VDOM boundary.
export default defineComponent({
  components: { LoaderCircle },
  props: {
    variant: { type: String as PropType<"default" | "primary" | "danger" | "ghost">, default: "default" },
    size: { type: String as PropType<"default" | "sm" | "icon">, default: "default" },
    type: { type: String as PropType<"button" | "submit" | "reset">, default: "button" },
    disabled: Boolean,
    loading: Boolean,
  },
  setup: () => ({
    variants: { default: "ui-button", primary: "ui-button-primary", danger: "ui-button-danger", ghost: "ui-button-ghost" },
    sizes: { default: "h-8 px-3", sm: "h-7 px-2", icon: "h-7 w-7 shrink-0 p-0" },
  }),
})
</script>

<template>
  <button :type="type" :class="[variants[variant], sizes[size]]" :disabled="disabled || loading" :aria-busy="loading || undefined">
    <LoaderCircle v-if="loading" :size="14" class="shrink-0 animate-spin" aria-hidden="true" />
    <slot />
  </button>
</template>
