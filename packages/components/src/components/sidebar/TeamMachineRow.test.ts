import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { fakeCentral, machineFixture } from "../../test/central.ts"
import TeamMachineRow from "./TeamMachineRow.vue"

let wrapper: VueWrapper | undefined
let session: AccountSession | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; session?.dispose(); session = undefined })

test("the local Team machine stays identifiable when another machine is selected", async () => {
  const local = machineFixture("mine", "team-1", "My laptop", false)
  const remote = machineFixture("remote", "team-1", "Build server")
  const fake = fakeCentral({
    machines: [local, remote],
    enrollment: {
      configured: true, connected: false, revoked: false,
      identity: { originId: "local-origin", machineId: "1" }, machineName: local.name,
      serverUrl: "https://fleet.example", teamId: "team-1", machineId: local.id,
    },
  })
  session = createAccountSession(fake.central)
  await flushPromises()
  session.selectMachine(remote.id)
  wrapper = mount(TeamMachineRow, {
    props: { machine: local },
    global: { plugins: [i18n], provide: { [accountSessionKey as symbol]: session } },
  })
  expect(wrapper.text()).toContain("This machine")
  expect(wrapper.text()).toContain("Offline")
  await wrapper.get("button").trigger("click")
  expect(wrapper.emitted("select")).toEqual([[]])
  await wrapper.setProps({ machine: remote })
  expect(wrapper.text()).not.toContain("This machine")
})

test("a web client's machines have no local badge", async () => {
  const machine = machineFixture("remote", "team-1", "Build server")
  session = createAccountSession(fakeCentral({ machines: [machine] }).central)
  await flushPromises()
  wrapper = mount(TeamMachineRow, {
    props: { machine },
    global: { plugins: [i18n], provide: { [accountSessionKey as symbol]: session } },
  })
  expect(wrapper.text()).not.toContain("This machine")
})
