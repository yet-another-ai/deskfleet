<script setup lang="ts">
import { watchImmediate } from "@vueuse/core"
import { ref } from "vue"
import { gravatarUrl } from "../../services/gravatar.ts"

const props = defineProps<{
  name: string
  email?: string | null
  /** Rendered width and height in CSS pixels. */
  size: number
}>()
const src = ref<string>()
const failed = ref(false)

watchImmediate(() => [props.email, props.size] as const, async ([email, size], _, onCleanup) => {
  let current = true
  onCleanup(() => { current = false })
  src.value = undefined
  failed.value = false
  if (!email) return
  // Without Web Crypto (an insecure origin), the initial remains.
  const url = await gravatarUrl(email, size * 2).catch(() => undefined)
  if (current) src.value = url
})
</script>

<template>
  <!-- The initial shows until the Gravatar loads, and stays when the address has none. -->
  <span class="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-ui-badge font-semibold text-ui-text-muted" :style="{ width: `${size}px`, height: `${size}px` }" aria-hidden="true">
    {{ name.charAt(0).toUpperCase() }}
    <img v-if="src && !failed" :src="src" alt="" referrerpolicy="no-referrer" class="absolute inset-0 h-full w-full object-cover" @error="failed = true" />
  </span>
</template>
