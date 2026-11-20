<script setup lang="ts">
import { computed, defineAsyncComponent, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter } from "vue-router"
import { useAccountSession } from "../composables/useAccountSession.ts"

const SuperAgentView = defineAsyncComponent(() => import("./SuperAgentView.vue"))
const account = useAccountSession()
const enabled = computed(() => account ? account.superAgentEnabled.value : false)
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
watch(enabled, value => {
  if (value === false && route.name === "super-agent") void router.replace({ name: "new-session" })
}, { immediate: true })
</script>

<template>
  <SuperAgentView v-if="enabled" :key="account?.teamId.value" />
  <p v-else-if="enabled === undefined" role="status" class="m-auto text-sm text-ui-text-muted">{{ t("welcome.loading") }}</p>
</template>
