<script setup lang="ts">
import { Settings } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import IconButton from "../common/IconButton.vue"
import { useFleetStore } from "../../stores/fleet.ts"
import { client as platformClient } from "@deskfleet/client/platform"
import { useAccountContext } from "../../composables/useAccountContext.ts"
import AccountMenu from "./AccountMenu.vue"

const { t } = useI18n()
const router = useRouter()
const fleet = useFleetStore()
const account = useAccountContext()
const name = computed(() => platformClient.target ? fleet.machines.find(machine => machine.id === fleet.targetId)?.name ?? t("catalog.local") : t("catalog.local"))
const initial = computed(() => name.value.charAt(0).toUpperCase())
</script>

<template>
  <footer class="flex h-12 shrink-0 items-center gap-1 border-t border-ui-border px-2">
    <AccountMenu v-if="account" />
    <div
      v-else
      class="flex min-w-0 flex-1 items-center gap-2 px-1"
    >
      <span
        class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-ui-avatar text-xs font-semibold text-white"
        aria-hidden="true"
      >
        {{ initial }}
      </span>
      <span class="truncate">{{ name }}</span>
    </div>
    <IconButton :icon="Settings" :label="t('nav.settings')" @click="router.push({ name: 'settings' })" />
  </footer>
</template>
