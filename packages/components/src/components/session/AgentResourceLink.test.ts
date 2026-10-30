import { client } from "@deskfleet/client/platform"
import { flushPromises, mount } from "@vue/test-utils"
import { computed, ref } from "vue"
import { expect, test, vi } from "vitest"
import type { FileResourceRequest, FilesApi, FileTarget } from "../../../../client/src/files.ts"
import { i18n } from "../../i18n/index.ts"
import { agentResourceContextKey, type AgentResourceContext } from "../../services/agent-resources.ts"
import AgentResourceLink from "./AgentResourceLink.vue"

test.each<FileTarget>([
  { kind: "machine", teamId: "team", machineId: "machine" },
  { kind: "local", grantId: "session-preview-grant" },
])("previews and downloads with cloneable requests from reactive $kind context", async target => {
  const original = client.files
  const context = ref<AgentResourceContext>({ target, sessionId: "session" })
  const resolveResource = vi.fn(async (request: FileResourceRequest) => {
    structuredClone(request)
    return { name: "file.txt", path: "/file.txt", kind: "file" as const, size: 7, modifiedAt: 0 }
  })
  const readResource = vi.fn(async (request: FileResourceRequest) => {
    structuredClone(request)
    return { data: new TextEncoder().encode("content"), name: "file.txt", mimeType: "text/plain" }
  })
  const saveResource = vi.fn(async (request: FileResourceRequest) => {
    structuredClone(request)
    return "download"
  })
  client.files = { resolveResource, readResource, saveResource } as unknown as FilesApi
  const view = mount(AgentResourceLink, {
    props: { uri: "/file.txt", name: "file.txt" },
    global: { plugins: [i18n], stubs: { Teleport: { template: "<slot />" } }, provide: { [agentResourceContextKey as symbol]: computed(() => context.value) } },
  })
  try {
    await view.get("button").trigger("click")
    await flushPromises()
    expect(view.get("pre").text()).toBe("content")
    const expected = { target, sessionId: "session", uri: "/file.txt" }
    expect(resolveResource).toHaveBeenCalledExactlyOnceWith(expected)
    expect(readResource).toHaveBeenCalledExactlyOnceWith(expected)
    await view.findAll("button").find(button => button.text() === "Download")!.trigger("click")
    await flushPromises()
    expect(saveResource).toHaveBeenCalledExactlyOnceWith(expected)
    expect(view.find('[role="alert"]').exists()).toBe(false)
  } finally {
    view.unmount()
    client.files = original
  }
})

test("keeps the viewer open for equivalent contexts and closes it when the session or machine changes", async () => {
  const original = client.files
  const context = ref<AgentResourceContext | undefined>({ target: { kind: "machine", teamId: "team", machineId: "machine" }, sessionId: "session" })
  client.files = { resolveResource: vi.fn().mockResolvedValue({ name: "file", path: "/file", kind: "file" }), readResource: vi.fn().mockResolvedValue({ data: new TextEncoder().encode("content"), name: "file", mimeType: "text/plain" }) } as unknown as FilesApi
  const view = mount(AgentResourceLink, {
    props: { uri: "/file", name: "file" },
    global: { plugins: [i18n], stubs: { Teleport: { template: "<slot />" } }, provide: { [agentResourceContextKey as symbol]: computed(() => context.value) } },
  })
  try {
    await view.get("button").trigger("click")
    await flushPromises()
    expect(view.text()).toContain("content")
    context.value = { target: { kind: "machine", teamId: "team", machineId: "machine" }, sessionId: "session" }
    await flushPromises()
    expect(view.text()).toContain("content")
    context.value = { target: { kind: "machine", teamId: "team", machineId: "other" }, sessionId: "session" }
    await flushPromises()
    expect(view.text()).not.toContain("content")
    await view.get("button").trigger("click")
    await flushPromises()
    context.value = undefined
    await flushPromises()
    expect(view.text()).not.toContain("content")
  } finally {
    view.unmount()
    client.files = original
  }
})
