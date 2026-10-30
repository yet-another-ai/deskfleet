<script setup lang="ts">
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { GithubPullRequest } from "@deskfleet/client/central"

const props = defineProps<{ pullRequest: GithubPullRequest }>()
const { t } = useI18n()
const icons = { draft: GitPullRequestDraft, open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed }
const colors = { draft: "text-ui-text-muted", open: "text-ui-success", merged: "text-purple-500", closed: "text-ui-danger" }
const label = computed(() => t("pullRequest.indicator", { number: props.pullRequest.number, title: props.pullRequest.title, state: t(`pullRequest.${props.pullRequest.state}`) }))
</script>

<template>
  <span class="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" :class="colors[pullRequest.state]" role="status" :title="label" :aria-label="label" :data-pull-request="pullRequest.state">
    <component :is="icons[pullRequest.state]" :size="14" :stroke-width="1.75" aria-hidden="true" />
  </span>
</template>
