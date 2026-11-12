<script setup lang="ts">
import { watch } from "vue"
import { useSpring } from "../../composables/useSpring.ts"

const props = defineProps<{ target: number; initial?: number; duration?: number; bounce?: number }>()
const motion = useSpring(props.initial ?? props.target, { duration: props.duration, bounce: props.bounce })
watch(() => props.target, value => motion.setTarget(value), { immediate: true })
defineExpose(motion)
</script>

<template>
  <slot :position="motion.position.value" :velocity="motion.velocity.value" :active="motion.isActive.value" />
</template>
