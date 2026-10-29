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
  <div class="group relative">
    <RouterLink
      :to="to"
      class="ui-nav-item"
      :class="[indent[depth], $slots.actions ? 'pr-9' : 'pr-2.5']"
      active-class="ui-nav-active"
    >
      <slot name="icon"><component :is="icon" :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" /></slot>
      <span class="truncate">{{ label }}</span>
      <slot name="trailing" />
    </RouterLink>
    <div v-if="$slots.actions" class="absolute inset-y-0 right-1 flex items-center op-0 group-hover:op-100 group-focus-within:op-100">
      <slot name="actions" />
    </div>
  </div>
</template>
