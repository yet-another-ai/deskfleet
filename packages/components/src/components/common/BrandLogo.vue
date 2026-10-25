<script setup lang="ts">
withDefaults(defineProps<{ size?: number; decorative?: boolean }>(), {
  size: 32,
  decorative: false,
})

const source = new URL("../../assets/deskfleet.png", import.meta.url).href
</script>

<template>
  <img
    :src="source"
    :alt="decorative ? '' : 'deskfleet'"
    :aria-hidden="decorative || undefined"
    :width="size"
    :height="size"
    class="shrink-0 rounded-[22%] object-contain"
    draggable="false"
  />
</template>
