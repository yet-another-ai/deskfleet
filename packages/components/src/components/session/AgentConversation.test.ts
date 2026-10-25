import { client } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi, CentralEvent } from "../../../../client/src/central.ts"
import type { FilesApi, FileTarget } from "../../../../client/src/files.ts"
import { i18n } from "../../i18n/index.ts"
import { agentEvent, agentSnapshot } from "../../test/agent.ts"
import AgentConversation from "./AgentConversation.vue"

const originalFiles = client.files, originalCentral = client.central
let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; client.files = originalFiles; client.central = originalCentral })

function setup(authorizeLocalSession = vi.fn<NonNullable<FilesApi["authorizeLocalSession"]>>().mockResolvedValue({ kind: "local", grantId: "preview" })) {
  let event!: (value: CentralEvent) => void
  const unsubscribe = vi.fn()
  client.central = { onEvent: (listener: (value: CentralEvent) => void) => { event = listener; return unsubscribe } } as unknown as CentralApi
  const readResource = vi.fn().mockRejectedValue(new Error("No image data in this fixture"))
  client.files = { authorizeLocalSession, readResource } as unknown as FilesApi
  const snapshot = agentSnapshot()
  const events = [agentEvent(1, "acp", { sessionId: "provider-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "![Chart](chart.png)" } } })]
  wrapper = mount(AgentConversation, { props: { snapshot, events, resourceTarget: { kind: "local" } }, global: { plugins: [i18n] } })
  return { view: wrapper, snapshot, authorizeLocalSession, readResource, event, unsubscribe }
}

test("local previews wait for user authorization and retain the grant across streamed snapshots", async () => {
  const { view, snapshot, authorizeLocalSession, readResource, event, unsubscribe } = setup()
  await flushPromises()
  expect(authorizeLocalSession).not.toHaveBeenCalled()
  expect(readResource).not.toHaveBeenCalled()
  await view.get('button').trigger("click")
  await flushPromises()
  expect(authorizeLocalSession).toHaveBeenCalledExactlyOnceWith(snapshot.session.id)
  expect(readResource).toHaveBeenCalledExactlyOnceWith({ target: { kind: "local", grantId: "preview" }, sessionId: snapshot.session.id, uri: "chart.png" })
  await view.setProps({ snapshot: structuredClone(snapshot) })
  expect(view.text()).not.toContain("Allow local file previews")
  event({ type: "accountChanged" })
  await flushPromises()
  expect(view.text()).toContain("Allow local file previews")
  wrapper!.unmount(); wrapper = undefined
  expect(unsubscribe).toHaveBeenCalledOnce()
})

test("a Session change discards pending authorization", async () => {
  let finish!: (value: FileTarget | null) => void
  const pending = vi.fn<NonNullable<FilesApi["authorizeLocalSession"]>>(() => new Promise(resolve => { finish = resolve }))
  const { view, snapshot, readResource } = setup(pending)
  await view.get('button').trigger("click")
  await view.setProps({ snapshot: { ...snapshot, session: { ...snapshot.session, id: "other" } } })
  finish({ kind: "local", grantId: "stale" })
  await flushPromises()
  expect(readResource).not.toHaveBeenCalled()
  expect(view.text()).toContain("Allow local file previews")
})

test("remote previews retain their existing automatic read flow", async () => {
  const { view, authorizeLocalSession, readResource, snapshot } = setup()
  const remote = { kind: "machine", machineId: "machine", teamId: "team" } as const
  await view.setProps({ resourceTarget: remote })
  await flushPromises()
  expect(authorizeLocalSession).not.toHaveBeenCalled()
  expect(readResource).toHaveBeenCalledExactlyOnceWith({ target: remote, sessionId: snapshot.session.id, uri: "chart.png" })
  expect(view.text()).not.toContain("Allow local file previews")
})
