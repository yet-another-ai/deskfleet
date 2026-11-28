<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from "vue"
import type { RouteLocationNormalizedLoaded, RouteLocationRaw } from "vue-router"
import type { Machine } from "@deskfleet/client/central"
import App from "../../App.vue"
import type { AccountSession } from "../../composables/useAccountSession.ts"
import { useMachineRuntimes } from "../../composables/useMachineRuntimes.ts"
import { useWorkspaceAgentMode, workspaceRouteMachine } from "../../services/workspace-agent-navigation.ts"
import { router } from "../../router/index.ts"

// Route views remount on selection; the account retains each machine's runtime.
const props = defineProps<{ session: AccountSession; machine: Machine }>()
const emit = defineEmits<{ ready: [machineId: string] }>()
const workspaceMode = useWorkspaceAgentMode()
const runtimes = useMachineRuntimes()!
const root = useTemplateRef<HTMLElement>("root")
let unmount: (() => void) | undefined
let disposed = false

function enterOwner(route: Pick<RouteLocationNormalizedLoaded, "name" | "query" | "fullPath">): false | RouteLocationRaw | undefined {
  if (!workspaceMode.value) return
  const id = workspaceRouteMachine(route)
  if (!id) return
  const session = props.session
  if ((route.query.team !== undefined && route.query.team !== session.teamId.value)
    || !session.machines.value.some(item => item.id === id)) {
    // A project entry can show an inaccessible target without touching its resources.
    if (route.name === "session") return { name: "new-session", query: { machine: id, team: route.query.team } }
    return
  }
  if (id !== props.machine.id) {
    session.openMachineRoute(id, route.fullPath)
    return false
  }
}

// Also guard Back/Forward while a different machine's isolated App is mounted.
const stopNavigation = router.beforeResolve(to => {
  if (!disposed && unmount && props.session.machineId.value === props.machine.id) return enterOwner(to)
})

// Every store and cache is scoped to one machine so equal local IDs on two machines never meet.
onMounted(async () => {
  await router.isReady()
  if (disposed || !root.value || props.session.machineId.value !== props.machine.id) return
  const runtime = runtimes.open(props.machine)
  const route = router.currentRoute.value
  const destination = props.session.takeMachineDestination(props.machine.id)
  // Settings and management lists survive initialization; selected resources belong to the new scope.
  if (destination) {
    // Cross-machine results and desktop previews keep their overview in history for Back.
    if (route.name === "search" || route.name === "remote-desktops") await router.push(destination)
    else await router.replace(destination)
  } else if (workspaceMode.value && workspaceRouteMachine(route)) {
    const redirect = enterOwner(route)
    if (redirect === false) return
    if (redirect) await router.replace(redirect)
  } else if (!route.meta.fullWindow && route.name !== "super-agent" && route.name !== "new-project" && !(route.name === "session" && route.query.window === "session")) {
    const path = route.name === "search" ? props.session.searchPath.value : route.name === "remote-desktops" ? "/desktops" : route.name === "schedules" ? "/schedules" : route.name === "archived-sessions" ? "/sessions/archived" : "/"
    await router.replace(path)
  }
  if (disposed || !root.value || props.session.machineId.value !== props.machine.id || runtimes.opened.get(props.machine.id) !== runtime) return
  unmount = runtime.mount(App, root.value)
  emit("ready", props.machine.id)
})
onBeforeUnmount(() => {
  disposed = true
  stopNavigation()
  unmount?.()
})
</script>

<template>
  <div ref="root" class="min-h-0 flex-1 overflow-clip" />
</template>
