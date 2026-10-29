<script setup lang="ts">
import type { AppLocale } from "@deskfleet/client/i18n"
import ProductDemo from "./ProductDemo.vue"
withDefaults(defineProps<{ locale?: AppLocale }>(), { locale: "en-US" })
</script>

<template><ProductDemo kind="team" :locale="locale" /></template>
