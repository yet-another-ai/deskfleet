<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from "vue"
import type { Machine } from "@deskfleet/client/central"
import App from "../../App.vue"
import type { AccountSession } from "../../composables/useAccountSession.ts"
import { useMachineRuntimes } from "../../composables/useMachineRuntimes.ts"
import { router } from "../../router/index.ts"

// Route views remount on selection; the account retains each machine's runtime.
const props = defineProps<{ session: AccountSession; machine: Machine }>()
const emit = defineEmits<{ ready: [machineId: string] }>()
const runtimes = useMachineRuntimes()!
const root = useTemplateRef<HTMLElement>("root")
let unmount: (() => void) | undefined
let disposed = false

// Every store and cache is scoped to one machine so equal local IDs on two machines never meet.
onMounted(async () => {
  await router.isReady()
  if (disposed || !root.value || props.session.machineId.value !== props.machine.id) return
  const runtime = runtimes.open(props.machine)
  const route = router.currentRoute.value
  const destination = props.session.takeMachineDestination(props.machine.id)
  // Settings and management lists survive initialization; selected resources belong to the new scope.
  if (destination) await router.replace(destination)
  else if (!route.meta.fullWindow) {
    const path = route.name === "schedules" ? "/schedules" : route.name === "archived-sessions" ? "/sessions/archived" : "/"
    await router.replace(path)
  }
  if (disposed || !root.value) return
  unmount = runtime.mount(App, root.value)
  emit("ready", props.machine.id)
})
onBeforeUnmount(() => {
  disposed = true
  unmount?.()
})
</script>

<template>
  <div ref="root" class="min-h-0 flex-1" />
</template>
