<script setup lang="ts">
import { inject } from "vue"
import PaneHeader from "../chrome/PaneHeader.vue"
import { windowHeaderActionsTargetKey } from "../chrome/windowHeaderActions.ts"

defineProps<{ hasActions: boolean }>()
const windowHeaderActionsTarget = inject(windowHeaderActionsTargetKey)
const windowedMainWindow = !!windowHeaderActionsTarget
</script>

<template>
  <PaneHeader v-if="!windowedMainWindow">
    <slot />
    <template v-if="hasActions" #actions><slot name="actions" /></template>
  </PaneHeader>
  <Teleport v-if="hasActions && windowHeaderActionsTarget" defer :to="windowHeaderActionsTarget"><slot name="actions" /></Teleport>
</template>
