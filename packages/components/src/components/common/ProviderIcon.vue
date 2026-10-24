<script setup lang="ts">
import { Bot } from "@lucide/vue"
import { computed } from "vue"
import { iconForProvider } from "../../services/provider-icons.ts"

const props = withDefaults(defineProps<{ icon?: string; template?: string; size?: number }>(), { size: 20 })
const mark = computed(() => iconForProvider(props.icon, props.template))
const style = computed(() => ({
  width: `${props.size}px`, height: `${props.size}px`, backgroundColor: "currentColor",
  maskImage: mark.value ? `url("${mark.value.url}")` : undefined,
  maskSize: "contain", maskRepeat: "no-repeat", maskPosition: "center",
}))
</script>

<template>
  <span v-if="mark" class="inline-block shrink-0" :data-provider-icon="mark.id" aria-hidden="true" :style="style" />
  <Bot v-else :size="size" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
</template>
