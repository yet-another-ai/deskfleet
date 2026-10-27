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

// The parent keys this component by machine, so each machine gets a fresh mount.
const props = defineProps<{ host: DeskfleetDesktopApi; session: AccountSession; machine: Machine }>()
const appearance = useAppearanceStore()
const root = useTemplateRef<HTMLElement>("root")
let app: VueApp | undefined
let state: Pinia | undefined
let remote: ReturnType<typeof remoteMachineClient> | undefined
let disposed = false

// Every store and cache is scoped to one machine so equal local IDs on two machines never meet.
onMounted(async () => {
  await router.replace(router.currentRoute.value.name === "schedules" ? "/schedules" : "/")
  if (disposed || !root.value) return
  remote = remoteMachineClient(props.host, props.session.central, props.machine)
  configureClient(remote.api)
  state = createPinia()
  app = createApp(App).provide(accountSessionKey, props.session).provide(appearanceStoreKey, appearance).use(state).use(router).use(i18n)
  if (vaporInteropPlugin) app.use(vaporInteropPlugin)
  app.mount(root.value)
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
