<script setup lang="ts">
import { defineComponent, h, onBeforeUnmount, onMounted, useTemplateRef, watch } from "vue"
import type { Machine } from "@deskfleet/client/central"
import type { SuperAgentByoaTarget, SuperAgentSession } from "@deskfleet/client/super-agent"
import { useMachineRuntimes } from "../../composables/useMachineRuntimes.ts"
import SuperAgentByoaPane from "./SuperAgentByoaPane.vue"

/** Mounts the BYOA Super Agent pane inside its owning Machine's isolated runtime scope. */
const props = defineProps<{
  teamId: string
  machine: Machine
  sessionId?: string
  target: SuperAgentByoaTarget | null
  sessionMeta?: SuperAgentSession
  canConfigure: boolean
  hostedConfigured: boolean
}>()
const emit = defineEmits<{
  sessionChange: [session: SuperAgentSession, selectIt?: boolean]
  openConfig: []
  switchToCloud: []
}>()

const runtimes = useMachineRuntimes()
const root = useTemplateRef<HTMLElement>("root")
let unmount: (() => void) | undefined

function mountRuntime(): void {
  unmount?.()
  unmount = undefined
  if (!runtimes || !root.value) return
  const runtime = runtimes.open(props.machine)
  const Wrapper = defineComponent({
    name: "SuperAgentByoaMount",
    render: () => h(SuperAgentByoaPane, {
      teamId: props.teamId,
      machine: props.machine,
      sessionId: props.sessionId,
      target: props.target,
      sessionMeta: props.sessionMeta,
      canConfigure: props.canConfigure,
      hostedConfigured: props.hostedConfigured,
      onSessionChange: (session: SuperAgentSession, selectIt?: boolean) => emit("sessionChange", session, selectIt),
      onOpenConfig: () => emit("openConfig"),
      onSwitchToCloud: () => emit("switchToCloud"),
    }),
  })
  unmount = runtime.mount(Wrapper, root.value)
}

onMounted(mountRuntime)
watch(() => [props.teamId, props.machine.id], mountRuntime)
onBeforeUnmount(() => {
  unmount?.()
  unmount = undefined
})
</script>

<template>
  <div v-if="runtimes" ref="root" class="flex min-h-0 flex-1 flex-col overflow-clip" data-super-agent-byoa-host />
  <SuperAgentByoaPane
    v-else
    :team-id="teamId"
    :machine="machine"
    :session-id="sessionId"
    :target="target"
    :session-meta="sessionMeta"
    :can-configure="canConfigure"
    :hosted-configured="hostedConfigured"
    :on-session-change="(session, selectIt) => emit('sessionChange', session, selectIt)"
    :on-open-config="() => emit('openConfig')"
    :on-switch-to-cloud="() => emit('switchToCloud')"
  />
</template>
