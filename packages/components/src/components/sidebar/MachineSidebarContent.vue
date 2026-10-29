<script setup lang="ts">
import { useFleetStore } from "../../stores/fleet.ts"
import MachineSection from "./MachineSection.vue"

const fleet = useFleetStore()
</script>

<template>
  <p v-if="fleet.catalogError" role="alert" class="mx-2.5 mb-3 break-words text-xs text-ui-danger">{{ fleet.catalogError }}</p>
  <MachineSection v-for="machine in fleet.machines" :key="machine.id" :machine="machine" />
</template>
