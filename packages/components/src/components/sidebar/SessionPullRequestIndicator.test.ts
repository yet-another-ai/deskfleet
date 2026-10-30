import { mount } from "@vue/test-utils"
import { expect, test } from "vitest"
import { i18n } from "../../i18n/index.ts"
import SessionPullRequestIndicator from "./SessionPullRequestIndicator.vue"

test.each(["draft", "open", "merged", "closed"] as const)("renders accessible %s PR status without a nested control", state => {
  const wrapper = mount(SessionPullRequestIndicator, {
    props: { pullRequest: { number: 78, title: "Show branch PR status", url: "https://github.com/acme/app/pull/78", state } },
    global: { plugins: [i18n] },
  })
  const indicator = wrapper.get('[role="status"]')
  expect(indicator.attributes("title")).toBe(`PR #78 · ${state[0]!.toUpperCase()}${state.slice(1)} · Show branch PR status`)
  expect(indicator.attributes("aria-label")).toBe(indicator.attributes("title"))
  expect(indicator.attributes("data-pull-request")).toBe(state)
  expect(wrapper.find("a, button").exists()).toBe(false)
  wrapper.unmount()
})
