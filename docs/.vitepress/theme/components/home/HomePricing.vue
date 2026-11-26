<script setup lang="ts">
import { computed, onMounted } from "vue"
import { useFetch } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import { formatBillingPrice, type BillingInterval, type PublicPricing } from "@deskfleet/client/billing"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import { appendAttributionParams } from "@deskfleet/client/marketing-attribution"
import { trackAcquisitionConversion, userTelemetryConsent } from "@deskfleet/components/services/analytics.ts"
import { fileSize } from "@deskfleet/components/services/file-format.ts"
import { pricingCopy } from "./pricing-locales.ts"

const props = defineProps<{ locale: AppLocale }>()
const { t } = useI18n()
const copy = computed(() => pricingCopy[props.locale])
const hosted = "https://deskfleet.yetanother.ai"
const plansUrl = computed(() => appendAttributionParams(hosted + "/#/team/settings/plans", userTelemetryConsent.value))
const startUrl = computed(() => appendAttributionParams(hosted, userTelemetryConsent.value))
const { data: catalog, error, isFetching, execute } = useFetch(hosted + "/api/pricing", {
  credentials: "omit",
}, { immediate: false, timeout: 15000 }).json<PublicPricing>()
onMounted(() => { void execute() })
const periods: BillingInterval[] = ["month", "year"]
const plans = computed(() => catalog.value?.planCatalog ?? [])
const ratesUnavailable = computed(() => catalog.value?.paymentsAvailable && catalog.value.prices === null)
const showCredits = computed(() => plans.value.some(plan => plan.superAgentTokens !== 0))

function price(plan: string, period: BillingInterval) {
  const offer = catalog.value?.prices?.find(value => value.plan === plan && value.interval === period)
  return offer ? formatBillingPrice(offer, intlLocale(props.locale)) : t("billing.comparison.priceUnavailable")
}

function quota(value: number | null) {
  return value === null ? t("team.unlimited") : value.toLocaleString(intlLocale(props.locale))
}

function relay(value: number | null) {
  if (value === null) return t("team.unlimited")
  if (value === 0) return t("billing.notIncluded")
  if (value % 1_073_741_824 === 0) return t("billing.comparison.relayAmount", { amount: quota(value / 1_073_741_824) })
  return fileSize(value)
}

function openedHostedApp() {
  trackAcquisitionConversion("marketing_get_started_clicked", { destination: "cloud", source: "pricing" })
}
</script>

<template>
  <section id="pricing" class="pricing" aria-labelledby="pricing-heading">
    <header class="pricing__intro">
      <h2 id="pricing-heading" class="home-heading">{{ copy.title }}</h2>
      <p>{{ copy.lead }}</p>
    </header>

    <div v-if="plans.length" class="pricing__grid">
      <article v-for="plan in plans" :key="plan.plan" class="pricing__card">
        <h3>{{ t('billing.plan.' + plan.plan) }}</h3>
        <p v-if="plan.plan === 'free'" class="pricing__rate">{{ copy.free }}</p>
        <p v-else-if="plan.plan === 'enterprise'" class="pricing__rate">{{ copy.custom }}</p>
        <p v-else-if="!catalog?.paymentsAvailable" class="pricing__rate">{{ copy.noSales }}</p>
        <p v-else-if="ratesUnavailable" class="pricing__rate">{{ t('billing.comparison.priceUnavailable') }}</p>
        <dl v-else class="pricing__rates">
          <div v-for="period in periods" :key="period">
            <dt>{{ period === 'month' ? copy.months : copy.years }}</dt>
            <dd>{{ price(plan.plan, period) }}</dd>
          </div>
        </dl>
        <dl class="pricing__allowances">
          <div><dt>{{ t('team.usageMembers') }}</dt><dd>{{ quota(plan.maxMembers) }}</dd></div>
          <div><dt>{{ copy.sessions }}</dt><dd>{{ quota(plan.maxActiveSessions) }}</dd></div>
          <div><dt>{{ t('billing.turnsPerSession') }}</dt><dd>{{ quota(plan.maxTurnsPerSession) }}</dd></div>
          <div><dt>{{ copy.relay }}</dt><dd>{{ relay(plan.turnBytes) }}</dd></div>
          <div><dt>{{ t('billing.comparison.teamTurn') }}</dt><dd>{{ t(plan.teamTurnServers ? 'billing.comparison.included' : 'billing.notIncluded') }}</dd></div>
          <div v-if="showCredits"><dt>{{ t('billing.comparison.monthlyCredits') }}</dt><dd>{{ quota(plan.superAgentTokens) }}</dd></div>
        </dl>
        <footer v-if="plan.plan === 'enterprise' && catalog?.enterpriseContactEmail">
          <a :href="'mailto:' + catalog.enterpriseContactEmail">{{ t('billing.contactEnterprise') }}</a>
        </footer>
      </article>
    </div>

    <div v-if="!plans.length || ratesUnavailable || error" class="pricing__status">
      <span v-if="isFetching" role="status">{{ copy.loading }}</span>
      <span v-else-if="error" role="status">{{ copy.unavailable }}</span>
      <span v-else-if="catalog && !plans.length" role="status">{{ copy.noPlans }}</span>
      <button v-if="error || ratesUnavailable" type="button" :disabled="isFetching" @click="execute()">{{ copy.retry }}</button>
    </div>
    <p v-if="plans.length" class="pricing__note">{{ copy.relayHelp }}</p>
    <div class="pricing__actions">
      <a v-if="!catalog || plans.length" class="home-button home-button--solid" :href="startUrl" @click="openedHostedApp">{{ copy.start }}</a>
      <a v-if="!catalog || plans.length" :href="plansUrl" @click="openedHostedApp">{{ copy.compare }}</a>
      <a href="https://github.com/yet-another-ai/deskfleet/blob/main/agents/docs/self-hosted.md">{{ copy.selfHost }}</a>
    </div>
  </section>
</template>

<style scoped>
.pricing {
  inline-size: min(1180px, calc(100% - 48px));
  margin-inline: auto;
  padding-block: clamp(4rem, 9vw, 8rem) 0;
  scroll-margin-block-start: var(--home-sticky-top);
}
.pricing__intro { max-inline-size: 54rem; margin-block-end: 2rem; }
.pricing__intro p, .pricing__note, .pricing__status { color: var(--home-ink-2); }
.pricing__intro p { margin-block: 1rem 0; font-size: 1.125rem; line-height: 1.55; }
.pricing__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: 1rem; }
.pricing__card {
  display: grid;
  grid-row: span 4;
  grid-template-rows: auto auto 1fr auto;
  grid-template-rows: subgrid;
  min-inline-size: 0;
  padding: clamp(1rem, 2vw, 1.5rem);
  border: 1px solid var(--home-edge);
  border-radius: 1.25rem;
  background: var(--home-panel);
}
.pricing__card h3 { margin: 0; font-size: 1.5rem; line-height: 1.25; }
.pricing__card dl, .pricing__card dd, .pricing__rate { margin: 0; }
.pricing__rates > div, .pricing__allowances > div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .15rem .75rem; }
.pricing__rates > div { align-items: baseline; }
.pricing__rates dt, .pricing__allowances dt { color: var(--home-ink-2); }
.pricing__rates dd, .pricing__rate { font-size: 1.15rem; font-weight: 700; }
.pricing__allowances > div { padding-block: .7rem; border-block-start: 1px solid var(--home-edge); font-size: .875rem; }
.pricing__allowances dd { font-weight: 600; }
.pricing__note, .pricing__status { margin-block: 1.25rem; }
.pricing__actions, .pricing__status { display: flex; align-items: center; gap: .75rem 1.25rem; flex-wrap: wrap; }
.pricing a:not(.home-button), .pricing button { color: var(--home-ink); font-weight: 600; text-decoration: underline; text-underline-offset: .2em; }
.pricing :is(a, button):focus-visible { outline: 2px solid var(--ui-color-focus); outline-offset: 3px; }
</style>
