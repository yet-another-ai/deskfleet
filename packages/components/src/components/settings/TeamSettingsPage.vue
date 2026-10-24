<script setup lang="ts">
import { useAccountContext } from "../../composables/useAccountContext.ts"
import TeamSettings from "./TeamSettings.vue"
const context = useAccountContext()
</script>

<template>
  <TeamSettings v-if="context?.team.value && context.account.value.user" :key="context.team.value.id" :central="context.central" :team="context.team.value" :user-id="context.account.value.user.id" @changed="context.reload()" />
</template>
