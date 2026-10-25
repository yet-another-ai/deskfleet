<script setup lang="ts">
import { Bot } from "@lucide/vue"
import { computed, ref, watch } from "vue"
import { loadProviderIcons, matchProviderIcon, type ProviderIcon } from "../../services/provider-icons.ts"

const props = withDefaults(defineProps<{ icon?: string; template?: string; size?: number }>(), { size: 20 })
const mark = ref<ProviderIcon>()
const pending = ref(false)
watch(() => [props.icon, props.template] as const, async ([icon, template], _previous, onCleanup) => {
  if (!icon && !template) {
    mark.value = undefined
    pending.value = false
    return
  }
  let current = true
  onCleanup(() => { current = false })
  pending.value = true
  const catalog = await loadProviderIcons()
  if (!current) return
  mark.value = matchProviderIcon(catalog.iconsById, icon, template)
  pending.value = false
}, { immediate: true })
const box = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }))
const style = computed(() => mark.value ? {
  ...box.value, backgroundColor: "currentColor",
  maskImage: `url("${mark.value.url}")`, maskSize: "contain", maskRepeat: "no-repeat", maskPosition: "center",
} : box.value)
</script>

<template>
  <span v-if="mark" class="inline-block shrink-0" :data-provider-icon="mark.id" aria-hidden="true" :style="style" />
  <span v-else-if="pending" class="inline-block shrink-0" :style="style" aria-hidden="true" />
  <Bot v-else :size="size" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
</template>
