<script setup lang="ts">
import { Settings } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import UiButton from "../common/UiButton.vue"
import AccountMenu from "./AccountMenu.vue"

const { t } = useI18n()
const session = useAccountSession()!
</script>

<template>
  <footer class="flex h-12 shrink-0 items-center gap-1 border-t border-ui-border px-2">
    <AccountMenu />
    <slot />
    <UiButton variant="ghost" size="icon" :label="t('nav.settings')" @click="session.openSettings('preferences')"><Settings :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
  </footer>
</template>
