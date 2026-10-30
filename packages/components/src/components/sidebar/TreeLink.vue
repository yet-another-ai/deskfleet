<script setup lang="ts">
import { computed, type Component } from "vue"
import { RouterLink, type RouteLocationRaw } from "vue-router"
import { useAccountSession } from "../../composables/useAccountSession.ts"

const props = defineProps<{
  to: RouteLocationRaw
  machineId?: string
  icon: Component
  label: string
  /** Nesting below the machine: 0 for machine items, 1 under a workspace, 2 under a worktree. */
  depth: 0 | 1 | 2
}>()

const account = useAccountSession()
const selected = computed(() => !account || !props.machineId || account.machineId.value === props.machineId)
const indent = { 0: "pl-2.5", 1: "pl-6", 2: "pl-10" } as const

function open(event: MouseEvent, navigate: (event?: MouseEvent) => unknown): void {
  if (!account || !props.machineId) { void navigate(event); return }
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return
  if ((event.currentTarget as HTMLAnchorElement).target === "_blank") return
  event.preventDefault()
  account.openMachineRoute(props.machineId, props.to)
}
</script>

<template>
  <div class="group relative">
    <RouterLink
      :to="to"
      v-slot="{ href, navigate, isActive, isExactActive }"
      custom
    >
      <a :href="href" class="ui-nav-item pr-2.5" :class="[indent[depth], selected && isActive && 'ui-nav-active']" :aria-current="selected && isExactActive ? 'page' : undefined" @click="open($event, navigate)">
        <slot name="icon"><component :is="icon" :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" /></slot>
        <span class="min-w-0 flex-1 truncate">{{ label }}</span>
        <span v-if="$slots.trailing || $slots.actions" class="inline-flex w-3.5 shrink-0 items-center justify-center" :class="$slots.actions && 'group-hover:op-0 group-focus-within:op-0'">
          <slot name="trailing" />
        </span>
      </a>
    </RouterLink>
    <div v-if="$slots.actions" class="absolute inset-y-0 right-1 flex items-center op-0 group-hover:op-100 group-focus-within:op-100">
      <slot name="actions" />
    </div>
  </div>
</template>
