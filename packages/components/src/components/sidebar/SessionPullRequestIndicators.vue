<script setup lang="ts">
import { watch } from "vue"
import { usePullRequestsStore } from "../../stores/pull-requests.ts"
import SessionPullRequestIndicator from "./SessionPullRequestIndicator.vue"

const props = defineProps<{ machineId: string; sessionId: string }>()
const pullRequests = usePullRequestsStore()
watch(() => [props.machineId, props.sessionId] as const, ([machineId, sessionId], _, onCleanup) => {
  onCleanup(pullRequests.observe(machineId, sessionId))
}, { immediate: true })
</script>

<template>
  <SessionPullRequestIndicator v-for="pullRequest in pullRequests.forSession(machineId, sessionId)" :key="pullRequest.url" :pull-request="pullRequest" />
</template>
