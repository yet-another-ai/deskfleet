<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { X } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import IconButton from "../common/IconButton.vue"

const { t } = useI18n()
const session = useAccountSession()
</script>

<template>
  <!-- Account-wide conditions that outlast any single action stay visible above the footer. -->
  <div v-if="session && (!session.connected.value || session.enrollment.value?.revoked || session.notice.value)" class="flex shrink-0 flex-col gap-1.5 px-2 pb-2">
    <p v-if="!session.connected.value" role="status" class="m-0 rounded-lg border border-ui-warning/30 bg-ui-warning/8 px-2.5 py-2 text-xs text-ui-warning">{{ t("account.signalingOffline") }}</p>
    <div v-if="session.enrollment.value?.revoked" role="status" class="rounded-lg border border-ui-border bg-ui-surface px-2.5 py-2 text-xs text-ui-text-muted">
      <p class="m-0">{{ t("account.enrollmentRevoked") }}</p>
      <UiButton variant="ghost" size="sm" v-if="session.canEnrollLocal.value && session.team.value" type="button" class="-ml-2 mt-1 cursor-pointer text-ui-text hover:bg-ui-hover" @click="session.dialog.value = 'add-machine'">{{ t("account.reconnectThisComputer") }}</UiButton>
    </div>
    <div v-if="session.notice.value" role="alert" class="flex items-start gap-1 rounded-lg border border-ui-danger/30 bg-ui-danger/8 py-1 pr-1 pl-2.5 text-xs text-ui-danger">
      <p class="m-0 min-w-0 flex-1 break-words py-1">{{ session.notice.value }}</p>
      <IconButton :icon="X" :label="t('account.dismiss')" @click="session.notice.value = undefined" />
    </div>
  </div>
</template>
