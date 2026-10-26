import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import type { LocalEnrollment } from "@deskfleet/client/central"
import { accountSessionKey, createAccountSession, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import { fakeCentral, machineFixture } from "../../test/central.ts"
import AddMachineDialog from "./AddMachineDialog.vue"
import { parseDaemonStatus } from "./daemon-status.ts"

let view: VueWrapper | undefined
let session: AccountSession | undefined
afterEach(() => { view?.unmount(); view = undefined; session?.dispose(); session = undefined })
const status = (value: Record<string, unknown> = {}) => JSON.stringify({ configured: false, connected: false, revoked: false, identity: { originId: "server-origin", machineId: "1" }, machineName: "ssh-box", ...value }, null, 2)
const local = (value: Partial<LocalEnrollment> = {}): LocalEnrollment => ({ configured: false, connected: false, revoked: false, identity: { originId: "o", machineId: "1" }, machineName: "This Mac", ...value })
async function setup(enrollment?: LocalEnrollment) {
  const fake = fakeCentral({ enrollment, machines: enrollment?.machineId ? [machineFixture(enrollment.machineId, enrollment.teamId!, "This Mac")] : [] })
  session = createAccountSession(fake.central)
  await flushPromises()
  view = mount(AddMachineDialog, { global: { stubs: { teleport: { inheritAttrs: false, template: "<slot />" } }, plugins: [i18n], provide: { [accountSessionKey as symbol]: session } }, attachTo: document.body })
  await flushPromises()
  return fake
}

test("daemon status output is accepted only for an unregistered installation", () => {
  expect(parseDaemonStatus(status())).toEqual({ ok: true, name: "ssh-box", originId: "server-origin", localMachineId: "1" })
  expect(parseDaemonStatus("deskfleet-daemon status")).toEqual({ ok: false, reason: "invalid" })
  expect(parseDaemonStatus(status({ identity: { originId: "x", machineId: "one" } }))).toEqual({ ok: false, reason: "invalid" })
  expect(parseDaemonStatus(status({ configured: true }))).toEqual({ ok: false, reason: "enrolled" })
  expect(parseDaemonStatus(status({ configured: true, revoked: true }))).toEqual({ ok: false, reason: "revoked" })
})

test("the Web client adds another machine from pasted status output and shows its credential once", async () => {
  const fake = await setup()
  expect(view!.find("[data-add-machine]").exists()).toBe(false)
  const input = view!.get<HTMLTextAreaElement>('[name="daemon-status"]')
  expect(document.activeElement).toBe(input.element)
  await input.setValue(status({ configured: true }))
  expect(view!.text()).toContain("already belongs to a team")
  expect(view!.get('button[type="submit"]').attributes("disabled")).toBeDefined()
  await input.setValue(status())
  expect((view!.get('[name="machine-name"]').element as HTMLInputElement).value).toBe("ssh-box")
  await view!.get('[name="machine-name"]').setValue("SSH server")
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(fake.central.enrollHeadless).toHaveBeenCalledExactlyOnceWith("team-1", { name: "SSH server", originId: "server-origin", localMachineId: "1" })
  expect(view!.get("h2").text()).toBe("Finish on the machine")
  const fields = view!.findAll<HTMLInputElement | HTMLTextAreaElement>("[readonly]")
  expect(fields[0]!.element.value).toBe("deskfleet-daemon enroll --server-url https://fleet.example")
  expect(JSON.parse(fields[1]!.element.value)).toEqual({ machineId: "machine-1", teamId: "team-1", token: "machine-token" })
  expect(document.activeElement).toBe(fields[1]!.element)
  expect(session!.machines.value.map(machine => machine.name)).toEqual(["SSH server"])
})

test("a failed registration keeps the pasted identity for retry", async () => {
  const fake = await setup()
  fake.central.enrollHeadless.mockRejectedValueOnce(new Error("Machine identity already registered"))
  await view!.get('[name="daemon-status"]').setValue(status())
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("Machine identity already registered")
  expect((view!.get('[name="daemon-status"]').element as HTMLTextAreaElement).value).toBe(status())
})

test.each([false, true])("the desktop connects this computer under its hostname by default (previously removed=%s)", async revoked => {
  const fake = await setup(local(revoked ? { configured: true, revoked: true, serverUrl: "https://fleet.example", teamId: "team-1", machineId: "old" } : {}))
  const option = view!.get('[data-add-machine="local"]')
  expect(option.text()).toContain(revoked ? "new, empty identity" : "computer you are using now")
  await option.trigger("click")
  await flushPromises()
  const input = view!.get<HTMLInputElement>('[name="machine-name"]')
  expect(input.element.value).toBe("This Mac")
  expect(document.activeElement).toBe(input.element)
  expect(fake.central.enrollLocal).not.toHaveBeenCalled()
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(fake.central.enrollLocal).toHaveBeenCalledExactlyOnceWith("team-1", "This Mac")
  expect(view!.emitted("close")).toEqual([[]])
  expect(session!.machine.value?.name).toBe("This Mac")
})

test("this computer can be given another Team name before connecting", async () => {
  const fake = await setup(local())
  await view!.get('[data-add-machine="local"]').trigger("click")
  await flushPromises()
  await view!.get('[name="machine-name"]').setValue("  Design MacBook  ")
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(fake.central.enrollLocal).toHaveBeenCalledExactlyOnceWith("team-1", "Design MacBook")
  expect(session!.machine.value?.name).toBe("Design MacBook")
})

test("an active registration of this computer is never reassigned", async () => {
  const fake = await setup(local({ configured: true, serverUrl: "https://fleet.example", teamId: "team-1", machineId: "mine" }))
  const option = view!.get('[data-add-machine="local"]')
  expect(option.attributes("disabled")).toBeDefined()
  expect(option.text()).toContain("Already connected to Design team")
  await view!.get('[data-add-machine="headless"]').trigger("click")
  await flushPromises()
  expect(document.activeElement).toBe(view!.get('[name="daemon-status"]').element)
  expect(fake.central.enrollLocal).not.toHaveBeenCalled()
})
