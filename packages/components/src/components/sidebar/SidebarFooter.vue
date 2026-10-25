<script setup lang="ts">
import { Settings } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import IconButton from "../common/IconButton.vue"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import AccountFooter from "./AccountFooter.vue"

const { t } = useI18n()
const router = useRouter()
const account = useAccountSession()
const initial = computed(() => t("catalog.local").charAt(0).toUpperCase())
</script>

<template>
  <AccountFooter v-if="account" />
  <footer v-else class="flex h-12 shrink-0 items-center gap-1 border-t border-ui-border px-2">
    <div class="flex min-w-0 flex-1 items-center gap-2 px-1">
      <span
        class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-ui-avatar text-xs font-semibold text-white"
        aria-hidden="true"
      >
        {{ initial }}
      </span>
      <span class="truncate">{{ t("catalog.local") }}</span>
    </div>
    <IconButton :icon="Settings" :label="t('nav.settings')" @click="router.push({ name: 'settings' })" />
  </footer>
</template>
