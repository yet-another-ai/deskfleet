<script setup lang="ts">
defineProps<{ heading: string }>()
</script>

<template>
  <div class="relative isolate flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6">
    <div class="ui-aurora" aria-hidden="true" />
    <h1 class="ui-gradient-text m-0 pb-1 text-center text-3xl font-semibold tracking-tight">{{ heading }}</h1>
    <slot />
  </div>
</template>
