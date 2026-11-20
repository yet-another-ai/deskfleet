<script setup lang="ts">
import { useI18n } from "vue-i18n"
const { t } = useI18n()
</script>

<template>
  <ol class="flex flex-col gap-6 text-[15px] leading-[1.65]" :aria-label="t('agent.conversation')"><slot /></ol>
</template>

<style scoped>
/* Keep historical DOM and component state, but let the browser skip rendering
   distant rows. The remembered size preserves scrollback after a row is seen.
   Live/latest responses and explicitly located entries always render immediately. */
:slotted(.ui-conversation-history) {
  content-visibility: auto;
  contain-intrinsic-block-size: auto 24rem;
}
:slotted(.ui-conversation-history.ui-conversation-input) {
  contain-intrinsic-block-size: auto 5rem;
}
@media print {
  :slotted(.ui-conversation-history) { content-visibility: visible; }
}
</style>
