<script setup lang="ts">
import { computed } from "vue"
import { useData } from "vitepress"
import HomeDesk from "./HomeDesk.vue"
import ProductShowcase from "./ProductShowcase.vue"
import HomeValues from "./HomeValues.vue"
import HomeInstall from "./HomeInstall.vue"
import "./home.css"
const { lang } = useData()
const chinese = computed(() => lang.value.startsWith("zh"))
</script>

<template>
  <main class="deskfleet-home">
    <HomeDesk :chinese="chinese" />
    <ProductShowcase :chinese="chinese" />
    <HomeValues :chinese="chinese" />
    <HomeInstall :chinese="chinese" />
  </main>
</template>
