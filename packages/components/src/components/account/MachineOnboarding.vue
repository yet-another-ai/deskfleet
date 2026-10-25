<script setup lang="ts">
import { Monitor, Plus } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"

const { t } = useI18n()
const session = useAccountSession()!
</script>

<template>
  <!-- A Team without machines has nothing to browse until one is added. -->
  <div class="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 px-6 pb-16 text-center">
    <Monitor :size="32" :stroke-width="1.5" class="mb-1 text-ui-text-faint" aria-hidden="true" />
    <h1 class="m-0 text-lg font-semibold">{{ t("addMachine.emptyTitle", { team: session.team.value?.name ?? "" }) }}</h1>
    <p class="m-0 text-sm leading-relaxed text-ui-text-muted">{{ t("addMachine.emptyDescription") }}</p>
    <button type="button" class="catalog-button mt-2" @click="session.dialog.value = 'add-machine'">
      <Plus :size="15" :stroke-width="1.75" aria-hidden="true" />{{ t("account.addMachine") }}
    </button>
  </div>
</template>
