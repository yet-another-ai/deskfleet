import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import type { Team } from "@deskfleet/client/central"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { fakeCentral, machineFixture } from "../../test/central.ts"
import TeamSettings from "./TeamSettings.vue"
import { selectOption } from "../../test/controls.ts"

let view: VueWrapper | undefined
let session: AccountSession | undefined
afterEach(() => { view?.unmount(); view = undefined; session?.dispose(); session = undefined })
const button = (text: string) => view!.findAll("button").find(value => value.text() === text)
async function setup(role: Team["role"] = "admin") {
  const fake = fakeCentral({
    teams: [{ id: "team-1", name: "Design team", role }],
    machines: [machineFixture("m1", "team-1", "Build server"), machineFixture("m2", "team-1", "Laptop", false)],
  })
  session = createAccountSession(fake.central)
  await flushPromises()
  view = mount(TeamSettings, { global: { stubs: { teleport: { inheritAttrs: false, template: "<slot />" } }, plugins: [i18n], provide: { [accountSessionKey as symbol]: session } }, attachTo: document.body })
  await flushPromises()
  return fake
}

test("administrators rename the team from its settings", async () => {
  const fake = await setup()
  expect(view!.get("h1").text()).toBe("Design team")
  expect(button("Save")!.attributes("disabled")).toBeDefined()
  await view!.get('[name="team-name"]').setValue("  Product  ")
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(fake.central.renameTeam).toHaveBeenCalledExactlyOnceWith("team-1", "Product")
  expect(view!.get("h1").text()).toBe("Product")
  expect(session!.team.value?.name).toBe("Product")
})

test("roles change inline, and a rejected change restores the server's role", async () => {
  const fake = await setup()
  expect(view!.get('[data-member-id="user-1"]').text()).toContain("Ada(you)")
  expect(view!.find('[data-member-id="user-1"] select').exists()).toBe(false)
  const select = view!.get('[role="combobox"][aria-label="Role for Bob"]')
  await selectOption(view!, '[role="combobox"][aria-label="Role for Bob"]', "Admin")
  await flushPromises()
  expect(fake.central.setMemberRole).toHaveBeenCalledExactlyOnceWith("team-1", "user-2", "admin")
  fake.central.setMemberRole.mockRejectedValueOnce(new Error("At least one admin is required"))
  await selectOption(view!, '[role="combobox"][aria-label="Role for Bob"]', "Member")
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("At least one admin is required")
  expect(select.text()).toBe("Admin")
})

test("member removal confirms first and stays open with its error for retry", async () => {
  const fake = await setup()
  await view!.get('[aria-label="Remove Bob"]').trigger("click")
  await flushPromises()
  expect(fake.central.removeMember).not.toHaveBeenCalled()
  expect(view!.get("[role=dialog][data-state=open] h2").text()).toBe("Remove Bob?")
  fake.central.removeMember.mockRejectedValueOnce(new Error("Could not remove member"))
  await view!.get("[role=dialog][data-state=open]").findAll("button").find(value => value.text() === "Remove")!.trigger("click")
  await flushPromises()
  expect(view!.get('[role=dialog][data-state=open] [role="alert"]').text()).toBe("Could not remove member")
  await view!.get("[role=dialog][data-state=open]").findAll("button").find(value => value.text() === "Remove")!.trigger("click")
  await flushPromises()
  expect(fake.central.removeMember).toHaveBeenLastCalledWith("team-1", "user-2")
  expect(view!.find('[data-member-id="user-2"]').exists()).toBe(false)
  expect(view!.find("[role=dialog]").exists()).toBe(false)
})

test("invitations show a copyable one-time code", async () => {
  const fake = await setup()
  await button("Invite")!.trigger("click")
  await flushPromises()
  expect(document.activeElement).toBe(view!.get('[name="invite-email"]').element)
  await view!.get('[name="invite-email"]').setValue("new@example.test")
  await view!.get('[role=dialog] [role=radio][value="admin"]').trigger("click")
  await view!.get("[role=dialog][data-state=open] form").trigger("submit")
  await flushPromises()
  expect(fake.central.invite).toHaveBeenCalledExactlyOnceWith("team-1", "new@example.test", "admin")
  expect(view!.get("[role=dialog][data-state=open] h2").text()).toBe("Invitation ready")
  expect(view!.get("[role=dialog][data-state=open]").text()).toContain("new@example.test")
  const code = view!.get<HTMLInputElement>("[role=dialog][data-state=open] input[readonly]")
  expect(code.element.value).toBe("invitation-token")
  expect(document.activeElement).toBe(code.element)
  await button("Done")!.trigger("click")
  expect(view!.find("[role=dialog]").exists()).toBe(false)
})

test("administrators remove machines after confirmation", async () => {
  const fake = await setup()
  expect(view!.get('[data-team-machine-id="m1"]').text()).toContain("Online")
  expect(view!.get('[data-team-machine-id="m2"]').text()).toContain("Last seen")
  await view!.get('[aria-label="Remove Laptop"]').trigger("click")
  await view!.get("[role=dialog][data-state=open]").findAll("button").find(value => value.text() === "Remove")!.trigger("click")
  await flushPromises()
  expect(fake.central.removeMachine).toHaveBeenCalledExactlyOnceWith("m2")
  expect(view!.find('[data-team-machine-id="m2"]').exists()).toBe(false)
})

test("machines are renamed inline, and Escape cancels without leaving Settings", async () => {
  const fake = await setup("member")
  const trigger = view!.get('[aria-label="Rename Build server"]')
  await trigger.trigger("click")
  await flushPromises()
  const input = view!.get<HTMLInputElement>('[data-team-machine-id="m1"] input[name="machine-name"]')
  expect(input.element.value).toBe("Build server")
  expect(document.activeElement).toBe(input.element)
  await input.setValue("Ignored")
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
  input.element.dispatchEvent(escape)
  await flushPromises()
  expect(escape.defaultPrevented).toBe(true)
  expect(view!.find('input[name="machine-name"]').exists()).toBe(false)
  expect(document.activeElement).toBe(view!.get('[aria-label="Rename Build server"]').element)
  expect(fake.central.renameMachine).not.toHaveBeenCalled()

  await view!.get('[aria-label="Rename Build server"]').trigger("click")
  await flushPromises()
  fake.central.renameMachine.mockRejectedValueOnce(new Error("name must contain 1 to 200 bytes"))
  await view!.get('input[name="machine-name"]').setValue("GPU runner")
  await view!.get('[data-team-machine-id="m1"] form').trigger("submit")
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("name must contain 1 to 200 bytes")
  expect(view!.find('input[name="machine-name"]').exists()).toBe(true)
  await view!.get('[data-team-machine-id="m1"] form').trigger("submit")
  await flushPromises()
  expect(fake.central.renameMachine).toHaveBeenLastCalledWith("m1", "GPU runner")
  expect(view!.get('[data-team-machine-id="m1"]').text()).toContain("GPU runner")
  expect(session!.machines.value.find(machine => machine.id === "m1")?.name).toBe("GPU runner")
  expect(view!.find('[role="alert"]').exists()).toBe(false)
})

test("ordinary members see the roster and machines without administration controls", async () => {
  await setup("member")
  expect(view!.text()).toContain("You are a member of this team.")
  expect(view!.findAll("[data-member-id]")).toHaveLength(2)
  expect(view!.findAll("[data-team-machine-id]")).toHaveLength(2)
  expect(view!.find('[name="team-name"]').exists()).toBe(false)
  expect(view!.find("[data-member-id] select").exists()).toBe(false)
  expect(view!.find('[aria-label^="Remove"]').exists()).toBe(false)
  expect(button("Invite")).toBeUndefined()
  // Every member can add their own machines.
  await button("Add machine")!.trigger("click")
  expect(session!.dialog.value).toBe("add-machine")
})
