import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi, Team, TeamMember } from "@deskfleet/client/central"
import { i18n } from "../../i18n/index.ts"
import TeamSettings from "./TeamSettings.vue"

let view: VueWrapper | undefined
const button = (text: string) => view!.findAll("button").find(value => value.text() === text)!
afterEach(() => { view?.unmount(); view = undefined; vi.restoreAllMocks() })
async function setup(role: Team["role"] = "admin") {
  let members: TeamMember[] = [{ userId: "1", name: "Alice", email: "alice@example.test", role: "admin" }, { userId: "2", name: "Bob", email: "bob@example.test", role: "member" }]
  const central = {
    members: vi.fn(async () => members.map(member => ({ ...member }))),
    renameTeam: vi.fn(async () => {}),
    setMemberRole: vi.fn(async (_team: string, user: string, role: TeamMember["role"]) => { members = members.map(member => member.userId === user ? { ...member, role } : member) }),
    removeMember: vi.fn(async (_team: string, user: string) => { members = members.filter(member => member.userId !== user) }),
    invite: vi.fn(async () => ({ token: "invitation-token", expiresAt: "2026-11-20T12:00:00Z" })),
  } as unknown as CentralApi
  view = mount(TeamSettings, { props: { central, team: { id: "team-1", name: "Design team", role }, userId: "1" }, global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  return central
}

test("shows team settings inline with member summaries and saves the team name", async () => {
  const central = await setup()
  expect(view!.get("h1").text()).toBe("Team settings")
  expect(view!.find("dialog[open]").exists()).toBe(false)
  expect(view!.get('[data-member-id="1"]').text()).toContain("Alice(you)")
  expect(view!.get('[data-member-id="2"]').text()).toContain("bob@example.test")
  expect(view!.get('[data-member-id="2"]').text()).toContain("Member")
  expect(view!.find('[data-member-id] select').exists()).toBe(false)
  await view!.get('[name="team-name"]').setValue("  New team  ")
  await view!.get("section form").trigger("submit")
  await flushPromises()
  expect(central.renameTeam).toHaveBeenCalledExactlyOnceWith("team-1", "New team")
  expect(view!.emitted("changed")).toEqual([[]])
})

test("member actions support keyboard navigation, Escape focus restoration and role changes", async () => {
  const central = await setup()
  const trigger = view!.get('[aria-label="Actions for Bob"]')
  ;(trigger.element as HTMLButtonElement).focus()
  await trigger.trigger("keydown", { key: "ArrowDown" })
  await flushPromises()
  const choices = view!.findAll('[role="menuitemradio"]')
  expect(document.activeElement).toBe(choices[0]!.element)
  expect(choices[0]!.attributes("aria-checked")).toBe("true")
  await choices[0]!.trigger("keydown", { key: "ArrowDown" })
  expect(document.activeElement).toBe(choices[1]!.element)
  await choices[1]!.trigger("keydown", { key: "Escape" })
  await flushPromises()
  expect(view!.find('[role="menu"]').exists()).toBe(false)
  expect(document.activeElement).toBe(trigger.element)
  await trigger.trigger("click")
  await view!.findAll('[role="menuitemradio"]')[1]!.trigger("click")
  await flushPromises()
  expect(central.setMemberRole).toHaveBeenCalledExactlyOnceWith("team-1", "2", "admin")
  expect(view!.get('[data-member-id="2"]').text()).toContain("Admin")
  expect(document.activeElement).toBe(trigger.element)
})

test("member removal requires confirmation and keeps a failed removal available for retry", async () => {
  const central = await setup()
  vi.mocked(central.removeMember).mockRejectedValueOnce(new Error("Could not remove member"))
  await view!.get('[aria-label="Actions for Bob"]').trigger("click")
  await view!.get('[role="menuitem"]').trigger("click")
  await flushPromises()
  expect(central.removeMember).not.toHaveBeenCalled()
  expect(view!.get("dialog[open]").text()).toContain("Remove Bob from this team?")
  await button("Remove").trigger("click")
  await flushPromises()
  expect(view!.get('dialog[open] [role="alert"]').text()).toBe("Could not remove member")
  await button("Remove").trigger("click")
  await flushPromises()
  expect(central.removeMember).toHaveBeenLastCalledWith("team-1", "2")
  expect(view!.find('[data-member-id="2"]').exists()).toBe(false)
  expect(view!.find("dialog[open]").exists()).toBe(false)
  expect(document.activeElement?.textContent).toContain("Members")
})

test("invites a member in a focused dialog and shows the resulting code", async () => {
  const central = await setup()
  await button("Invite a member").trigger("click")
  await flushPromises()
  expect(document.activeElement).toBe(view!.get('[name="invite-email"]').element)
  await view!.get('[name="invite-email"]').setValue("new@example.test")
  await view!.get("dialog[open] select").setValue("admin")
  await view!.get("dialog[open] form").trigger("submit")
  await flushPromises()
  expect(central.invite).toHaveBeenCalledExactlyOnceWith("team-1", "new@example.test", "admin")
  expect(view!.get("dialog[open] h2").text()).toBe("Invitation ready")
  expect((view!.get("dialog[open] textarea").element as HTMLTextAreaElement).value).toBe("invitation-token")
  expect(document.activeElement).toBe(view!.get("dialog[open] textarea").element)
  await button("Done").trigger("click")
  expect(view!.find("dialog[open]").exists()).toBe(false)
})

test("ordinary members can read the roster without administration controls", async () => {
  await setup("member")
  expect(view!.findAll("[data-member-id]")).toHaveLength(2)
  expect(view!.find('[name="team-name"]').exists()).toBe(false)
  expect(view!.find('[data-member-actions]').exists()).toBe(false)
  expect(button("Invite a member")).toBeUndefined()
})
