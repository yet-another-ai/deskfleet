<script setup lang="ts">
import { whenever } from "@vueuse/core"
import { onMounted } from "vue"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useProvidersStore } from "../../stores/providers.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import MachineSection from "./MachineSection.vue"

const platformClient = usePlatformClient()
const fleet = useFleetStore()
const terminals = useTerminalsStore()
const agents = useAgentSessionsStore()
const providers = useProvidersStore()
whenever(() => fleet.localDesktopTarget.online, () => { void terminals.refresh() })
onMounted(() => {
  if (fleet.catalog || fleet.catalogLoading || fleet.catalogError) return
  void fleet.refreshLocal().then(() => {
    if (fleet.localDesktopTarget.online || platformClient.agent.history) void agents.refresh()
    if (fleet.localDesktopTarget.online || platformClient.providers.display) void providers.refresh()
  })
})
</script>

<template>
  <p v-if="fleet.catalogError" role="alert" class="mx-2.5 mb-3 break-words text-xs text-ui-danger">{{ fleet.catalogError }}</p>
  <MachineSection v-for="machine in fleet.machines" :key="machine.id" :machine="machine" />
</template>
