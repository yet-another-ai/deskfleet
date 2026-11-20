<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { Monitor, Plus } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"

defineProps<{ remoteWorkspaceAgent?: boolean }>()
const { t } = useI18n()
const session = useAccountSession()!
const compatible = computed(() => session.machines.value.filter(machine => machine.capabilities?.superAgent))
</script>

<template>
  <section v-if="remoteWorkspaceAgent && compatible.length" data-machine-picker class="m-auto flex w-full max-w-md flex-col gap-3 px-6">
    <h1 class="m-0 text-lg font-semibold">{{ t("superAgent.machineNav.chooseComputer") }}</h1>
    <UiButton v-for="item in compatible" :key="item.id" class="min-h-11 justify-start" @click="session.selectMachine(item.id)">
      <Monitor :size="16" aria-hidden="true" />
      <span class="min-w-0 truncate">{{ item.name }}</span>
      <small v-if="compatible.some(other => other.id !== item.id && other.name === item.name)" class="min-w-0 truncate text-ui-text-muted">{{ item.id }}</small>
      <span v-if="!item.online" class="ml-auto text-ui-text-muted">{{ t("machine.offline") }}</span>
    </UiButton>
  </section>
  <div v-else class="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 px-6 pb-16 text-center">
    <span class="mb-1 flex h-14 w-14 items-center justify-center rounded-2xl bg-ui-accent/10 text-ui-accent" aria-hidden="true"><Monitor :size="28" :stroke-width="1.5" /></span>
    <h1 class="m-0 text-lg font-semibold">{{ t("addMachine.emptyTitle", { team: session.team.value?.name ?? "" }) }}</h1>
    <p class="m-0 text-sm leading-relaxed text-ui-text-muted">{{ t(remoteWorkspaceAgent ? "superAgent.machineNav.connectComputer" : "addMachine.emptyDescription") }}</p>
    <UiButton v-if="remoteWorkspaceAgent" variant="primary" class="mt-2" @click="session.refreshMachines()">{{ t("superAgent.setup.checkAgain") }}</UiButton>
    <UiButton v-else variant="primary" type="button" class="mt-2" @click="session.dialog.value = 'add-machine'">
      <Plus :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("account.addMachine") }}
    </UiButton>
  </div>
</template>
