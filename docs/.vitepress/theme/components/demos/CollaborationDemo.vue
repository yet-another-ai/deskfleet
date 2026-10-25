<script setup lang="ts">
import ProductDemo from "./ProductDemo.vue"
withDefaults(defineProps<{ chinese?: boolean }>(), { chinese: false })
</script>

<template><ProductDemo kind="team" :chinese="chinese" /></template>
