<script setup lang="ts">
import { useElementOverflow } from "@vueuse/core"
import { useTemplateRef } from "vue"

const title = useTemplateRef<HTMLElement>("title")
const { isXOverflowed } = useElementOverflow(title, { observeMutation: true })
</script>

<template>
  <span ref="title" class="min-w-0 overflow-hidden whitespace-nowrap" :class="{ 'ui-tab-title-overflow': isXOverflowed }"><slot /></span>
</template>

<style scoped>
.ui-tab-title-overflow {
  mask-image: linear-gradient(to right, #000 calc(100% - 16px), transparent);
}
</style>
