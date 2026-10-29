<script setup lang="ts">
import { computed } from "vue"
import { useData } from "vitepress"
import { resolveAppLocale } from "@deskfleet/client/i18n"
import HomeDesk from "./HomeDesk.vue"
import ProductShowcase from "./ProductShowcase.vue"
import HomeValues from "./HomeValues.vue"
import HomeInstall from "./HomeInstall.vue"
import "./home.css"
const { lang } = useData()
const locale = computed(() => resolveAppLocale([lang.value]))
</script>

<template>
  <main class="deskfleet-home">
    <HomeDesk :locale="locale" />
    <ProductShowcase :locale="locale" />
    <HomeValues :locale="locale" />
    <HomeInstall :locale="locale" />
  </main>
</template>
