<script setup lang="ts">
import DefaultTheme from "vitepress/theme-without-fonts"
import { useData } from "vitepress"
import { watch } from "vue"
import { useI18n } from "vue-i18n"
const { Layout } = DefaultTheme
const { lang } = useData()
const { locale } = useI18n()
watch(lang, value => { locale.value = value.startsWith("zh") ? "zh-cmn-Hans-CN" : "en-US" }, { immediate: true })
</script>

<template><Layout /></template>
