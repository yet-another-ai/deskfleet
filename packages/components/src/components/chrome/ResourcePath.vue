<script setup lang="ts">
defineProps<{ segments: string[] }>()
</script>

<template>
  <span class="ml-2 font-normal text-ui-text-faint">{{ segments.join(" / ") }}</span>
</template>
