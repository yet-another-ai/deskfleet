<script setup lang="ts">
import { computed } from "vue"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import TeamAiUsage from "../team/TeamAiUsage.vue"

const session = useAccountSession()
const team = computed(() => session?.team.value)
</script>

<template>
  <TeamAiUsage v-if="team" :key="team.id" :team="team" />
</template>
