<script setup lang="ts">
import { ExternalLink } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import BrandLogo from "../common/BrandLogo.vue"
import UpdatesSettings from "./UpdatesSettings.vue"

const { t } = useI18n()
const projects = [
  { name: "Electron", url: "https://github.com/electron/electron" },
  { name: "Node.js", url: "https://github.com/nodejs/node" },
  { name: "Vue", url: "https://github.com/vuejs/core" },
  { name: "Vue Router", url: "https://github.com/vuejs/router" },
  { name: "Pinia", url: "https://github.com/vuejs/pinia" },
  { name: "Vue I18n", url: "https://github.com/intlify/vue-i18n" },
  { name: "VueUse", url: "https://github.com/vueuse/vueuse" },
  { name: "Reka UI", url: "https://github.com/unovue/reka-ui" },
  { name: "Lucide", url: "https://github.com/lucide-icons/lucide" },
  { name: "xterm.js", url: "https://github.com/xtermjs/xterm.js" },
  { name: "Shiki", url: "https://github.com/shikijs/shiki" },
  { name: "Mermaid", url: "https://github.com/mermaid-js/mermaid" },
  { name: "KaTeX", url: "https://github.com/KaTeX/KaTeX" },
  { name: "Apache ECharts", url: "https://github.com/apache/echarts" },
  { name: "Actix Web", url: "https://github.com/actix/actix-web" },
  { name: "Tokio", url: "https://github.com/tokio-rs/tokio" },
  { name: "SeaORM", url: "https://github.com/SeaQL/sea-orm" },
  { name: "napi-rs", url: "https://github.com/napi-rs/napi-rs" },
]
</script>

<template>
  <h1 class="ui-page-title mb-2">{{ t("aboutSettings.title") }}</h1>
  <div class="mb-6 mt-5 flex items-center gap-4">
    <BrandLogo :size="48" decorative />
    <div>
      <p class="m-0 text-lg font-semibold">DeskFleet</p>
      <p class="m-0 mt-1 text-sm text-ui-text-muted">{{ t("aboutSettings.description") }}</p>
    </div>
  </div>

  <UpdatesSettings />

  <section aria-labelledby="about-feedback" class="mt-6">
    <h2 id="about-feedback" class="mb-3 text-base font-semibold">{{ t("aboutSettings.feedback") }}</h2>
    <div class="ui-card p-4">
      <p class="m-0 mb-3 text-sm leading-relaxed text-ui-text-muted">{{ t("aboutSettings.feedbackDescription") }}</p>
      <a href="https://github.com/yet-another-ai/deskfleet/issues" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 text-sm text-ui-accent hover:underline">
        {{ t("aboutSettings.openIssues") }}
        <ExternalLink :size="14" aria-hidden="true" />
      </a>
    </div>
  </section>

  <section aria-labelledby="about-open-source" class="mt-6">
    <h2 id="about-open-source" class="mb-3 text-base font-semibold">{{ t("aboutSettings.openSource") }}</h2>
    <div class="ui-card p-4">
      <p class="m-0 mb-4 text-sm leading-relaxed text-ui-text-muted">{{ t("aboutSettings.openSourceDescription") }}</p>
      <ul class="m-0 grid list-none grid-cols-1 gap-x-6 gap-y-3 p-0 sm:grid-cols-2">
        <li v-for="project in projects" :key="project.name">
          <a :href="project.url" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-2 text-sm text-ui-accent hover:underline">
            {{ project.name }}
            <ExternalLink :size="12" aria-hidden="true" />
          </a>
        </li>
      </ul>
    </div>
  </section>

  <p class="mb-0 mt-8 text-center text-sm leading-relaxed text-ui-text-muted">{{ t("aboutSettings.thanks") }}</p>
</template>
