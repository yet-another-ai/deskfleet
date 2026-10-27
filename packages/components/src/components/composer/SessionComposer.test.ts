import { client as platformClient } from "@deskfleet/client/platform"
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { ref } from "vue"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { buildPromptContent, type ComposerAttachment } from "../../services/composer-attachments.ts"
import type { WorkspaceLocation } from "../../stores/fleet.ts"
import { workspaceId } from "../../test/catalog.ts"
import AgentContent from "../session/AgentContent.vue"
import SessionComposer from "./SessionComposer.vue"

let pinia: ReturnType<typeof createPinia> | undefined

afterEach(() => {
  if (pinia) disposePinia(pinia)
  pinia = undefined
  vi.restoreAllMocks()
})

test("composer folds long pasted text into an attachment chip, enforces text requirement for image-only drafts, and attaches machine files", async () => {
  vi.spyOn(platformClient.files!, "list").mockResolvedValue({
    path: "/repo",
    parentPath: "/",
    homePath: "/repo",
    roots: [{ name: "/", path: "/" }],
    entries: [
      { name: "README.md", path: "/repo/README.md", kind: "file", size: 128, modifiedAt: 1000 },
    ],
  })

  pinia = createPinia()
  const location: WorkspaceLocation = {
    machine: { id: "local-daemon", name: "Host", local: true, online: true, desktop: true, workspaces: [], sessions: [], terminals: [] },
    workspace: { id: workspaceId, name: "DeskFleet", directories: [{ path: "/repo", git: undefined }], sessions: [], terminals: [] },
  }

  const modelValue = ref("")
  const attachments = ref<ComposerAttachment[]>([])
  const submitted = vi.fn()

  const wrapper = mount(SessionComposer, {
    attachTo: document.body,
    props: {
      location,
      modelValue: modelValue.value,
      "onUpdate:modelValue": (value: string) => {
        modelValue.value = value
        void wrapper.setProps({ modelValue: value })
      },
      attachments: attachments.value,
      "onUpdate:attachments": (value: ComposerAttachment[]) => {
        attachments.value = value
        void wrapper.setProps({ attachments: value })
      },
      onSubmit: () => submitted(),
    },
    global: {
      plugins: [pinia, router, i18n],
      stubs: { AgentConfigurationSelector: true },
    },
  })

  const page = new DOMWrapper(document.body)

  // Attach a machine file via the + menu and FilePickerDialog
  await wrapper.get("[data-composer-attach]").trigger("click")
  await flushPromises()
  await page.get("[data-attach-machine]").trigger("click")
  await flushPromises()
  await page.get('button[data-path="/repo/README.md"]').trigger("click")
  await page.get("[data-confirm-files]").trigger("click")
  await flushPromises()

  expect(attachments.value).toHaveLength(1)
  expect(attachments.value[0]?.kind).toBe("machine_file")
  expect(wrapper.get('[aria-label="Send"]').attributes("disabled")).toBeDefined()

  // Paste 30 lines of text -> folds into a pasted_text attachment chip and enables Send
  const longText = Array.from({ length: 30 }, (_, index) => `line ${index + 1}: diagnostic output`).join("\n")
  const textarea = wrapper.get("textarea")
  const pasteEvent = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(pasteEvent, "clipboardData", {
    value: {
      files: [],
      items: [],
      getData: (type: string) => (type === "text/plain" ? longText : ""),
    },
  })
  textarea.element.dispatchEvent(pasteEvent)
  await flushPromises()

  expect(attachments.value).toHaveLength(2)
  expect(attachments.value[1]?.kind).toBe("pasted_text")
  expect(wrapper.find('[data-attachment-kind="pasted_text"]').exists()).toBe(true)
  expect(wrapper.get('[aria-label="Send"]').attributes("disabled")).toBeUndefined()

  const pastedId = attachments.value[1]!.id
  const blocks = await buildPromptContent({
    draft: modelValue.value,
    attachments: attachments.value,
    sessionId: "30",
    target: { kind: "local" },
    filesApi: platformClient.files,
  })
  expect(blocks).toEqual([
    { type: "resource_link", uri: "file:///repo/README.md", name: "README.md", size: 128 },
    {
      type: "resource",
      resource: {
        uri: `deskfleet://pasted-text/${pastedId}.txt`,
        mimeType: "text/plain",
        text: longText,
      },
    },
  ])

  wrapper.unmount()

  // Render the resulting blocks in AgentContent and verify collapsible pasted text card
  const contentWrapper = mount(AgentContent, {
    props: { content: blocks },
    global: { plugins: [pinia, router, i18n] },
  })
  const card = contentWrapper.get("[data-pasted-resource]")
  expect(card.text()).toContain("30 lines")
  expect(card.get("button").attributes("aria-expanded")).toBe("false")
  expect(card.get("button").text()).toContain("Show all")
  await card.get("button").trigger("click")
  expect(card.get("button").attributes("aria-expanded")).toBe("true")
  expect(card.get("button").text()).toContain("Collapse")
  expect(card.get("pre").text()).toContain("line 30: diagnostic output")
})
