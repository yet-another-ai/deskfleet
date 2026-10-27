<script setup lang="ts">
import { computed } from "vue"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import TeamPlansUsage from "../team/TeamPlansUsage.vue"

const session = useAccountSession()
const team = computed(() => session?.team.value)
</script>

<template>
  <TeamPlansUsage v-if="team" :key="team.id" :team="team" />
</template>
