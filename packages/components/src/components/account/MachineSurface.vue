<script setup lang="ts">
import { createApp, onBeforeUnmount, onMounted, useTemplateRef, vaporInteropPlugin, type App as VueApp } from "vue"
import { createPinia, disposePinia, type Pinia } from "pinia"
import type { Machine } from "@deskfleet/client/central"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { configureClient } from "@deskfleet/client/platform"
import { remoteMachineClient } from "@deskfleet/client/remote"
import App from "../../App.vue"
import { accountSessionKey, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { appearanceStoreKey, useAppearanceStore } from "../../stores/appearance.ts"
import { useLayoutStore } from "../../stores/layout.ts"

// The parent keys this component by machine, so each machine gets a fresh mount.
const props = defineProps<{ host: DeskfleetDesktopApi; session: AccountSession; machine: Machine }>()
const emit = defineEmits<{ ready: [machineId: string] }>()
const appearance = useAppearanceStore()
const root = useTemplateRef<HTMLElement>("root")
let app: VueApp | undefined
let state: Pinia | undefined
let remote: ReturnType<typeof remoteMachineClient> | undefined
let disposed = false

// Every store and cache is scoped to one machine so equal local IDs on two machines never meet.
onMounted(async () => {
  await router.isReady()
  if (disposed || !root.value || props.session.machineId.value !== props.machine.id) return
  remote = remoteMachineClient(props.host, props.session.central, props.machine)
  configureClient(remote.api)
  const route = router.currentRoute.value
  const destination = props.session.takeSessionDestination(props.machine.id)
  // Settings and management lists survive initialization; selected resources belong to the new scope.
  if (destination) await router.replace({ name: "session", params: { sessionId: destination } })
  else if (!route.meta.fullWindow) {
    const path = route.name === "schedules" ? "/schedules" : route.name === "archived-sessions" ? "/sessions/archived" : "/"
    await router.replace(path)
  }
  if (disposed || !root.value) return
  state = createPinia()
  // Management lists preserve their route, but cannot reuse another machine's resource destination.
  useLayoutStore(state).conversationPath = "/"
  app = createApp(App).provide(accountSessionKey, props.session).provide(appearanceStoreKey, appearance).use(state).use(router).use(i18n)
  if (vaporInteropPlugin) app.use(vaporInteropPlugin)
  app.mount(root.value)
  emit("ready", props.machine.id)
})
onBeforeUnmount(() => {
  disposed = true
  app?.unmount()
  if (state) disposePinia(state)
  remote?.dispose()
  configureClient(props.host)
})
</script>

<template>
  <div ref="root" class="min-h-0 flex-1" />
</template>
