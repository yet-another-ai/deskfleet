<script setup lang="ts">
import githubIcon from "@lobehub/icons-static-svg/icons/github.svg?url"
import { computed } from "vue"
const props = withDefaults(defineProps<{ size?: number }>(), { size: 16 })
const style = computed(() => ({ width: `${props.size}px`, height: `${props.size}px`, maskImage: `url("${githubIcon}")` }))
</script>

<template>
  <span aria-hidden="true" class="inline-block shrink-0 bg-current" :style="style" style="mask-size: contain; mask-position: center; mask-repeat: no-repeat" />
</template>
