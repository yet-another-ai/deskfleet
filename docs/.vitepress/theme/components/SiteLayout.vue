<script setup lang="ts">
import DefaultTheme from "vitepress/theme-without-fonts"
import { useData } from "vitepress"
import { watch } from "vue"
import { useI18n } from "vue-i18n"
import { resolveAppLocale } from "@deskfleet/client/i18n"
const { Layout } = DefaultTheme
const { lang } = useData()
const { locale } = useI18n()
watch(lang, value => { locale.value = resolveAppLocale([value]) }, { immediate: true })
</script>

<template>
  <Layout>
    <template #nav-bar-content-after>
      <a class="get-started" href="https://deskfleet.yetanother.ai">Get Started</a>
    </template>
  </Layout>
</template>

<style scoped>
.get-started {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  height: 36px;
  margin-inline-start: 16px;
  padding: 0 16px;
  border-radius: 8px;
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
  font-size: 14px;
  font-weight: 600;
}

.get-started:hover {
  background: var(--vp-button-brand-hover-bg);
  color: var(--vp-button-brand-hover-text);
}

@media (max-width: 480px) {
  .get-started {
    margin-inline-start: 8px;
    padding-inline: 12px;
  }
}
</style>
