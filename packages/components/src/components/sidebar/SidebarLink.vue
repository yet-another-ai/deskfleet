<script setup lang="ts">
import type { Component } from "vue"
import { RouterLink, type RouteLocationRaw } from "vue-router"

defineProps<{
  to: RouteLocationRaw
  icon: Component
  label: string
  /** Replace the current history entry instead of adding one. */
  replace?: boolean
  /** Stay highlighted on the pages beneath this link, not only on the link's own page. */
  section?: boolean
}>()
</script>

<template>
  <RouterLink
    :to="to"
    :replace="replace"
    class="ui-nav-item px-2.5"
    :active-class="section ? 'ui-nav-active' : undefined"
    exact-active-class="ui-nav-active"
  >
    <component :is="icon" :size="16" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
    <span class="truncate">{{ label }}</span>
  </RouterLink>
</template>
