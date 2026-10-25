import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { agentInput } from "../../test/agent.ts"
import { fakeCentral } from "../../test/central.ts"
import UserAvatar from "../common/UserAvatar.vue"
import AgentActor from "./AgentActor.vue"
import AgentUserMessage from "./AgentUserMessage.vue"

const memberId = "019b00a1-2345-7000-8000-000000000002"
let session: AccountSession | undefined
let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); view = undefined; session?.dispose(); session = undefined })

test("conversation authors and dispatchers use account and member names with the author's avatar", async () => {
  const fake = fakeCentral({ members: [{ userId: memberId, name: "Grace Hopper", email: "grace@example.test", role: "member" }] })
  session = createAccountSession(fake.central)
  await flushPromises()
  const input = agentInput({
    author: { kind: "user", userId: memberId },
    dispatcher: { kind: "user", userId: "user-1" },
    state: "delivered", actualDelivery: "steer",
  })
  view = mount(AgentUserMessage, { props: { input }, global: { plugins: [i18n], provide: { [accountSessionKey as symbol]: session } } })
  expect(view.findAllComponents(AgentActor).map(actor => actor.text())).toEqual(["Grace Hopper", "Ada"])
  expect(view.text()).not.toContain(memberId)
  expect(view.getComponent(UserAvatar).props()).toMatchObject({ name: "Grace Hopper", email: "grace@example.test", size: 32 })
  expect(view.getComponent(UserAvatar).get("span").attributes("title")).toBe("Grace Hopper")

  await view.setProps({ input: { ...input, author: { kind: "user", userId: "user-1" } } })
  expect(view.getComponent(AgentActor).text()).toBe("Ada")
  expect(view.getComponent(UserAvatar).props()).toMatchObject({ name: "Ada", email: "ada@example.test" })
  session.account.value.user!.name = " "
  await flushPromises()
  expect(view.getComponent(AgentActor).text()).toBe("ada@example.test")
  expect(view.getComponent(UserAvatar).props("name")).toBe("ada@example.test")
})

test("actor names update when the Team directory arrives and retain a fallback for unavailable identities", async () => {
  const fake = fakeCentral()
  session = createAccountSession(fake.central)
  await flushPromises()
  view = mount(AgentActor, { props: { actor: { kind: "user", userId: memberId } }, global: { plugins: [i18n], provide: { [accountSessionKey as symbol]: session } } })
  expect(view.text()).toBe(memberId)
  session.members.value.push({ userId: memberId, name: "Grace Hopper", email: null, role: "member" })
  await flushPromises()
  expect(view.text()).toBe("Grace Hopper")
  await view.setProps({ actor: { kind: "system" } })
  expect(view.text()).toBe("System")
  await view.setProps({ actor: { kind: "user" } })
  expect(view.text()).toBe("Local user")
})
