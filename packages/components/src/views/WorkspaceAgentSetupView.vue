<script setup lang="ts">
import { Laptop } from "@lucide/vue"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import AddMachineDialog from "../components/account/AddMachineDialog.vue"
import UiButton from "../components/common/UiButton.vue"
import { useAccountSession } from "../composables/useAccountSession.ts"

const { t } = useI18n()
const session = useAccountSession()!
const connect = ref(false)
const checking = ref(false)

async function checkAgain() {
  if (checking.value) return
  checking.value = true
  try { await session.refreshMachines() }
  finally { checking.value = false }
}
</script>

<template>
  <section data-workspace-agent-setup class="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 px-6 pb-16 text-center">
    <span class="mb-1 flex h-14 w-14 items-center justify-center rounded-2xl bg-ui-accent/10 text-ui-accent" aria-hidden="true"><Laptop :size="28" :stroke-width="1.5" /></span>
    <h1 class="m-0 text-xl font-semibold">{{ t("superAgent.defaultWorkspace") }}</h1>
    <p class="m-0 text-sm leading-relaxed text-ui-text-muted">{{ t(session.canEnrollLocal.value ? "superAgent.setup.description" : "superAgent.setup.unavailable") }}</p>
    <UiButton v-if="session.canEnrollLocal.value" variant="primary" class="mt-2" data-connect-workspace-agent @click="connect = true">
      {{ t("superAgent.setup.connect") }}
    </UiButton>
    <div v-else class="mt-2 flex flex-wrap justify-center gap-2">
      <UiButton variant="primary" @click="session.openSettings('preferences')">{{ t("superAgent.setup.settings") }}</UiButton>
      <UiButton :loading="checking" :disabled="checking" @click="checkAgain">{{ t("superAgent.setup.checkAgain") }}</UiButton>
    </div>
    <AddMachineDialog v-if="connect && session.canEnrollLocal.value" :key="session.teamId.value" local-only @close="connect = false" />
  </section>
</template>
