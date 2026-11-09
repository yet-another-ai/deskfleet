<script setup lang="ts">
import { computed } from "vue"
import { useData } from "vitepress"
import { resolveAppLocale } from "@deskfleet/client/i18n"
import HomeDesk from "./HomeDesk.vue"
import HomeAgentRelay from "./HomeAgentRelay.vue"
import HomeRemoteDesktop from "./HomeRemoteDesktop.vue"
import ProductShowcase from "./ProductShowcase.vue"
import HomeValues from "./HomeValues.vue"
import HomeNetwork from "./HomeNetwork.vue"
import HomeInstall from "./HomeInstall.vue"
import "./home.css"
const { lang } = useData()
const locale = computed(() => resolveAppLocale([lang.value]))
</script>

<template>
  <main class="deskfleet-home">
    <HomeDesk :locale="locale" />
    <HomeAgentRelay :locale="locale" />
    <HomeRemoteDesktop :locale="locale" />
    <ProductShowcase :locale="locale" />
    <HomeValues :locale="locale" />
    <HomeNetwork :locale="locale" />
    <HomeInstall :locale="locale" />
  </main>
</template>
