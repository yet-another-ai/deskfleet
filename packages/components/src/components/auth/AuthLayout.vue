<script setup lang="ts">
import type { Component } from "vue"
import BrandLogo from "../common/BrandLogo.vue"
import UiScrollArea from "../common/UiScrollArea.vue"

/** The centered card every authentication step shares; the footer holds links to sibling steps. */
defineProps<{ title: string; description?: string; icon?: Component }>()
</script>

<template>
  <UiScrollArea as="main" class="h-full bg-ui-canvas text-ui-text" content-class="flex min-h-full flex-col items-center px-4 py-10 sm:py-16">
    <a href="/" class="mb-8 flex shrink-0 items-center gap-2.5 text-[15px] font-semibold"><BrandLogo :size="28" decorative />DeskFleet</a>
    <section class="ui-card w-full max-w-[25rem] shrink-0 p-7 sm:p-8">
      <span v-if="icon" class="mb-5 flex h-10 w-10 items-center justify-center rounded-full border border-ui-border bg-ui-sidebar text-ui-text-muted">
        <component :is="icon" :size="18" :stroke-width="1.75" aria-hidden="true" />
      </span>
      <h1 class="m-0 text-xl font-semibold">{{ title }}</h1>
      <p v-if="description" class="m-0 mt-2 text-sm leading-relaxed text-ui-text-muted">{{ description }}</p>
      <div class="mt-6"><slot /></div>
    </section>
    <nav v-if="$slots.footer" class="mt-6 flex shrink-0 flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-ui-text-muted">
      <slot name="footer" />
    </nav>
  </UiScrollArea>
</template>
