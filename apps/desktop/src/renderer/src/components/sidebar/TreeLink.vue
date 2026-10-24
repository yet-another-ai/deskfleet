<script setup lang="ts">
import type { Component } from "vue"
import { RouterLink, type RouteLocationRaw } from "vue-router"

defineProps<{
  to: RouteLocationRaw
  icon: Component
  label: string
  /** Nesting below the machine: 0 for machine items, 1 under a workspace, 2 under a worktree. */
  depth: 0 | 1 | 2
}>()

const indent = { 0: "pl-2.5", 1: "pl-6", 2: "pl-10" } as const
</script>

<template>
  <RouterLink
    :to="to"
    class="flex h-8 items-center gap-2.5 rounded-lg pr-2.5 hover:bg-ui-hover"
    :class="indent[depth]"
    active-class="bg-ui-active"
  >
    <slot name="icon"><component :is="icon" :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" /></slot>
    <span class="truncate">{{ label }}</span>
  </RouterLink>
</template>
