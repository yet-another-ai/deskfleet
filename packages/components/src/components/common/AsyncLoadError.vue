<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { useAsyncLoadErrorActions } from "../../services/module-recovery.ts"
import UiButton from "./UiButton.vue"

const { t } = useI18n()
const actions = useAsyncLoadErrorActions()
</script>

<template>
  <div data-async-load-error role="alert" class="m-auto flex max-w-sm flex-col items-center gap-3 p-6 text-center">
    <p class="m-0 text-sm text-ui-text-muted">{{ t("remoteControl.moduleLoadFailed") }}</p>
    <div class="flex flex-wrap items-center justify-center gap-2">
      <UiButton v-if="actions" data-async-retry @click="actions.retry()">{{ t("remoteControl.retryModuleLoad") }}</UiButton>
      <UiButton v-if="actions" data-async-reload variant="ghost" @click="actions.reload()">{{ t("remoteControl.reloadPage") }}</UiButton>
    </div>
  </div>
</template>
