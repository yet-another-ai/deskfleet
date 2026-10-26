<script setup lang="ts">
import { Settings } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import IconButton from "../common/IconButton.vue"
import AccountMenu from "./AccountMenu.vue"

const { t } = useI18n()
const session = useAccountSession()!
</script>

<template>
  <footer class="flex h-12 shrink-0 items-center gap-1 border-t border-ui-border px-2">
    <AccountMenu />
    <slot />
    <IconButton :icon="Settings" :label="t('nav.settings')" @click="session.openSettings('preferences')" />
  </footer>
</template>
