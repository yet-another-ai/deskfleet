<script setup lang="ts">
import { computed, type Component, type HTMLAttributes } from "vue"
import { RouterLink, type RouteLocationRaw } from "vue-router"
import { useAccountSession } from "../../composables/useAccountSession.ts"

const props = defineProps<{
  to: RouteLocationRaw
  machineId?: string
  icon?: Component
  label: string
  dragSource?: HTMLAttributes
  /** Nesting below the machine: 0 for machine items, 1 under a workspace, 2 under a worktree. */
  depth: 0 | 1 | 2
}>()

const account = useAccountSession()
const selected = computed(() => !account || !props.machineId || account.machineId.value === props.machineId)
const indent = { 0: "pl-2.5", 1: "pl-4", 2: "pl-[41px]" } as const

function open(event: MouseEvent, navigate: (event?: MouseEvent) => unknown): void {
  if (!account || !props.machineId) { void navigate(event); return }
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return
  if ((event.currentTarget as HTMLAnchorElement).target === "_blank") return
  event.preventDefault()
  account.openMachineRoute(props.machineId, props.to)
}
</script>

<template>
  <RouterLink
    :to="to"
    v-slot="{ href, navigate, isActive, isExactActive }"
    custom
  >
    <div
      class="group flex h-8 items-center rounded-lg ui-motion"
      :class="selected && isActive ? 'ui-nav-active hover:bg-ui-accent/20' : 'text-ui-text hover:bg-ui-hover'"
    >
      <a
        v-bind="dragSource"
        :href="href"
        class="flex h-full min-w-0 flex-1 items-center gap-2.5 text-[13px] text-current no-underline active:scale-[0.985]"
        :class="[indent[depth], $slots.actions ? 'pr-2.5 group-hover:pr-1 can-hover:group-has-[:focus-visible]:pr-1' : 'pr-2.5']"
        :aria-current="selected && isExactActive ? 'page' : undefined"
        @click="open($event, navigate)"
      >
        <slot name="icon"><component v-if="icon" :is="icon" :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" /></slot>
        <span class="min-w-0 flex-1 truncate">{{ label }}</span>
        <span
          v-if="$slots.trailing"
          class="inline-flex shrink-0 items-center justify-center gap-1.5 ui-motion"
          :class="$slots.actions && 'group-hover:max-w-0 group-hover:overflow-hidden group-hover:op-0 can-hover:group-has-[:focus-visible]:max-w-0 can-hover:group-has-[:focus-visible]:overflow-hidden can-hover:group-has-[:focus-visible]:op-0'"
        >
          <slot name="trailing" />
        </span>
      </a>
      <div
        v-if="$slots.actions"
        class="hidden can-hover:flex shrink-0 items-center overflow-hidden max-w-0 op-0 pointer-events-none ui-motion group-hover:max-w-10 group-hover:pr-1 group-hover:op-100 group-hover:pointer-events-auto group-has-[:focus-visible]:max-w-10 group-has-[:focus-visible]:pr-1 group-has-[:focus-visible]:op-100 group-has-[:focus-visible]:pointer-events-auto"
        :class="selected && isActive ? 'text-ui-accent/70' : 'text-ui-text-faint'"
      >
        <slot name="actions" />
      </div>
    </div>
  </RouterLink>
</template>
