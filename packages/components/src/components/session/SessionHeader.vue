<script setup lang="ts">
import { inject } from "vue"
import PaneHeader from "../chrome/PaneHeader.vue"
import { windowHeaderActionsTargetKey } from "../chrome/windowHeaderActions.ts"

withDefaults(defineProps<{ hasActions: boolean; sidebar?: boolean }>(), { sidebar: true })
const windowHeaderActionsTarget = inject(windowHeaderActionsTargetKey, undefined)
const windowedMainWindow = !!windowHeaderActionsTarget
</script>

<template>
  <PaneHeader v-if="!windowedMainWindow" :sidebar="sidebar">
    <slot />
    <template v-if="hasActions" #actions><slot name="actions" /></template>
  </PaneHeader>
  <Teleport v-if="hasActions && windowHeaderActionsTarget" defer :to="windowHeaderActionsTarget"><slot name="actions" /></Teleport>
</template>
