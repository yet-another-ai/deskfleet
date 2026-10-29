<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from "vue"
import type { MachineRuntime } from "../../composables/useMachineRuntimes.ts"
import MachineSidebarContent from "./MachineSidebarContent.vue"

const props = defineProps<{ runtime: MachineRuntime }>()
const root = useTemplateRef<HTMLElement>("root")
let unmount: (() => void) | undefined
onMounted(() => { if (root.value) unmount = props.runtime.mount(MachineSidebarContent, root.value) })
onBeforeUnmount(() => unmount?.())
</script>

<template>
  <div ref="root" class="mt-4 first:mt-0" />
</template>
