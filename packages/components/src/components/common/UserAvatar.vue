<script setup lang="ts">
import { watchImmediate } from "@vueuse/core"
import { computed, ref } from "vue"
import { avatarInitials, loadGravatar } from "../../services/gravatar.ts"

const props = defineProps<{
  name: string
  email?: string | null
  /** Rendered width and height in CSS pixels. */
  size: number
  /** Hover text. Defaults to the person's name. */
  label?: string
}>()
const src = ref<string>()
const failed = ref(false)
const initials = computed(() => avatarInitials(props.name))
const fontSize = computed(() => Math.max(8, Math.round(props.size * (initials.value.length > 1 ? 0.34 : 0.45))))

watchImmediate(() => [props.email, props.size] as const, ([email, size], _, onCleanup) => {
  let current = true
  onCleanup(() => { current = false })
  src.value = undefined
  failed.value = false
  if (!email) return
  // Probe first so a missing Gravatar never becomes a broken image.
  // Device pixels, so a CSS-sized avatar stays sharp. A missing image never reaches the element.
  void loadGravatar(email, size * 2).then(url => { if (current) src.value = url })
})
</script>

<template>
  <span
    class="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-ui-avatar font-semibold text-ui-avatar-text"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${fontSize}px` }"
    :title="label || name"
    aria-hidden="true"
  >
    {{ initials }}
    <img v-if="src && !failed" :src="src" alt="" referrerpolicy="no-referrer" class="absolute inset-0 h-full w-full object-cover" @error="failed = true" />
  </span>
</template>
