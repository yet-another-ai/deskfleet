<script setup lang="ts">
import { Eye, EyeOff } from "@lucide/vue"
import { ref, useId } from "vue"
import { useI18n } from "vue-i18n"

/** A password input with a reveal toggle. New passwords show the site's length rule. */
const props = defineProps<{ label: string; purpose: "current" | "new"; disabled?: boolean; autofocus?: boolean }>()
const password = defineModel<string>({ required: true })
const { t } = useI18n()
const id = useId()
const visible = ref(false)
</script>

<template>
  <div class="flex flex-col gap-1.5 text-sm">
    <div class="flex items-center justify-between gap-3">
      <label :for="id">{{ label }}</label>
      <slot name="aside" />
    </div>
    <div class="relative">
      <input
        :id="id"
        v-model="password"
        class="ui-input pr-9"
        :type="visible ? 'text' : 'password'"
        name="password"
        :autocomplete="props.purpose === 'current' ? 'current-password' : 'new-password'"
        required
        :minlength="props.purpose === 'new' ? 15 : undefined"
        maxlength="128"
        :disabled="disabled"
        :autofocus="autofocus"
        :aria-describedby="props.purpose === 'new' ? `${id}-hint` : undefined"
      />
      <button
        type="button"
        class="absolute inset-y-0 right-0 flex w-9 cursor-pointer items-center justify-center rounded-r-lg text-ui-text-muted hover:text-ui-text disabled:cursor-default disabled:op-50"
        :aria-label="t(visible ? 'auth.hidePassword' : 'auth.showPassword')"
        :aria-pressed="visible"
        :disabled="disabled"
        @click="visible = !visible"
      >
        <component :is="visible ? EyeOff : Eye" :size="15" :stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>
    <span v-if="props.purpose === 'new'" :id="`${id}-hint`" class="text-[13px] text-ui-text-muted">{{ t("auth.passwordHint") }}</span>
  </div>
</template>
