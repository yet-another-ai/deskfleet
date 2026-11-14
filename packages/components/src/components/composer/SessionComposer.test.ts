import { client as platformClient } from "@deskfleet/client/platform"
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { ref } from "vue"
import { i18n } from "../../i18n/index.ts"
import { router } from "../../router/index.ts"
import { buildPromptContent, type ComposerAttachment } from "../../services/composer-attachments.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import type { SessionTarget, WorkspaceLocation } from "../../stores/fleet.ts"
import { workspaceId } from "../../test/catalog.ts"
import AgentContent from "../session/AgentContent.vue"
import SessionComposer from "./SessionComposer.vue"

let pinia: ReturnType<typeof createPinia> | undefined

function dragEvent(type: string, dataTransfer: DataTransfer): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer })
  return event as DragEvent
}

test("composer leaves tab moves and other non-file drags untouched for the window drop target", async () => {
  pinia = createPinia()
  const wrapper = mount(SessionComposer, {
    props: { location: null },
    global: { plugins: [pinia, router, i18n] },
  })
  const transfer = new DataTransfer()
  // Dockview's HTML5 backend uses an empty text payload and permits only moves.
  transfer.setData("text/plain", "")
  transfer.effectAllowed = "move"
  transfer.dropEffect = "move"
  const received = vi.fn()
  wrapper.element.addEventListener("drop", received)
  await flushPromises()
  try {
    for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
      const event = dragEvent(type, transfer)
      wrapper.get("textarea").element.dispatchEvent(event)
      await flushPromises()
      expect(event.defaultPrevented).toBe(false)
      expect(transfer.dropEffect).toBe("move")
      expect(wrapper.find(".border-ui-accent").exists()).toBe(false)
    }
    expect(received).toHaveBeenCalledOnce()
    expect(wrapper.emitted("update:attachments")).toBeUndefined()
  } finally {
    wrapper.unmount()
  }
})

test("composer highlights file drags across its children and attaches files with no MIME type", async () => {
  pinia = createPinia()
  const wrapper = mount(SessionComposer, {
    props: { location: null },
    global: { plugins: [pinia, router, i18n] },
  })
  const transfer = new DataTransfer()
  transfer.items.add(new File(["hello"], "README"))
  // happy-dom exposes MIME types here instead of the browser's file marker.
  Object.defineProperty(transfer, "types", { value: ["Files"] })
  const textarea = wrapper.get("textarea").element
  const zone = textarea.parentElement!
  await flushPromises()
  try {
    zone.dispatchEvent(dragEvent("dragenter", transfer))
    textarea.dispatchEvent(dragEvent("dragenter", transfer))
    textarea.dispatchEvent(dragEvent("dragleave", transfer))
    await flushPromises()
    expect(zone.classList.contains("border-ui-accent")).toBe(true)
    zone.dispatchEvent(dragEvent("dragleave", transfer))
    await flushPromises()
    expect(zone.classList.contains("border-ui-accent")).toBe(false)

    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = dragEvent(type, transfer)
      textarea.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(transfer.dropEffect).toBe("copy")
    }
    await flushPromises()
    expect(zone.classList.contains("border-ui-accent")).toBe(false)
    expect(wrapper.emitted("update:attachments")?.[0]?.[0]).toEqual([
      expect.objectContaining({ kind: "local_file", name: "README", size: 5 }),
    ])
  } finally {
    wrapper.unmount()
  }
})

afterEach(() => {
  if (pinia) disposePinia(pinia)
  pinia = undefined
  vi.restoreAllMocks()
})

const yoloLocation: SessionTarget = {
  machine: { id: "local-daemon", name: "Host", local: true, online: true, desktop: true, workspaces: [], sessions: [], terminals: [] },
  session: { id: "yolo-session", title: "YOLO confirmation", provider: "codex", archiveState: "active", context: "directory" },
}

test("new-session composer picks, cancels, clears, and defaults the working directory", async () => {
  const home = {
    path: "/home/agent",
    parentPath: "/home",
    homePath: "/home/agent",
    roots: [{ name: "/", path: "/" }],
    directories: [
      { name: "code", path: "/home/agent/code", hidden: false },
      { name: "hidden", path: "/home/agent/hidden", hidden: true },
    ],
  }
  const code = {
    path: "/home/agent/code",
    parentPath: "/home/agent",
    homePath: "/home/agent",
    roots: [{ name: "/", path: "/" }],
    directories: [],
  }
  const browse = vi.spyOn(platformClient.filesystem, "listDirectories")
    .mockResolvedValueOnce(home)
    .mockResolvedValueOnce(code)
    .mockResolvedValueOnce(home)
  pinia = createPinia()
  const cwd = ref<string | undefined>()
  const location: WorkspaceLocation = {
    machine: { id: "local-daemon", name: "Host", local: true, online: true, desktop: true, workspaces: [], sessions: [], terminals: [] },
    workspace: { id: workspaceId, name: "DeskFleet", directories: [{ path: "/repo" }, { path: "/repo/apps" }], sessions: [], terminals: [] },
  }
  const wrapper = mount(SessionComposer, {
    attachTo: document.body,
    props: {
      location,
      showTarget: true,
      context: "directory",
      cwd: cwd.value,
      "onUpdate:cwd": (value: string | undefined) => {
        cwd.value = value
        void wrapper.setProps({ cwd: value })
      },
    },
    global: { plugins: [pinia, router, i18n], stubs: { AgentConfigurationSelector: true, SessionPreparation: true } },
  })
  const page = new DOMWrapper(document.body)
  try {
    expect(wrapper.get("[data-composer-cwd]").text()).toContain("repo")
    expect(wrapper.find("[data-composer-cwd-clear]").exists()).toBe(false)

    await wrapper.get("[data-composer-cwd]").trigger("click")
    await flushPromises()
    expect(browse).toHaveBeenCalled()
    await page.get('button[data-path="/home/agent/code"]').trigger("click")
    await flushPromises()
    await page.findAll("button").find(button => button.text() === i18n.global.t("folderPicker.select"))!.trigger("click")
    await flushPromises()
    await vi.waitFor(() => expect(cwd.value).toBe("/home/agent/code"))
    expect(wrapper.get("[data-composer-cwd]").text()).toContain("code")
    expect(wrapper.find("[data-composer-cwd-clear]").exists()).toBe(true)

    await wrapper.get("[data-composer-cwd]").trigger("click")
    await flushPromises()
    await page.findAll("button").find(button => button.text() === i18n.global.t("catalog.cancel"))!.trigger("click")
    await flushPromises()
    expect(cwd.value).toBe("/home/agent/code")
    await vi.waitFor(() => expect(page.find('[role="dialog"]').exists()).toBe(false))

    await wrapper.get("[data-composer-cwd-clear]").trigger("click")
    await flushPromises()
    expect(cwd.value).toBeUndefined()
    expect(wrapper.get("[data-composer-cwd]").text()).toContain("repo")

    await wrapper.setProps({ context: "worktree" })
    await flushPromises()
    expect(wrapper.find("[data-composer-cwd]").exists()).toBe(false)
  } finally {
    wrapper.unmount()
  }
})

test("machine-scoped new chats offer Home as the default working directory", async () => {
  pinia = createPinia()
  const wrapper = mount(SessionComposer, {
    attachTo: document.body,
    props: {
      location: { machine: { id: "local-daemon", name: "Host", local: true, online: true, desktop: true, workspaces: [], sessions: [], terminals: [] } },
      showTarget: true,
      context: "directory",
    },
    global: { plugins: [pinia, router, i18n], stubs: { AgentConfigurationSelector: true } },
  })
  try {
    expect(wrapper.get("[data-composer-cwd]").text()).toContain(i18n.global.t("composer.workingDirectoryHome"))
    expect(wrapper.get("[data-composer-cwd]").attributes("title")).toBe(i18n.global.t("composer.workingDirectoryHomeHint"))
  } finally {
    wrapper.unmount()
  }
})

test.each(["draft", "session"] as const)("YOLO in a %s requires confirmation to enable and disables immediately", async (scope) => {
  pinia = createPinia()
  const wrapper = mount(SessionComposer, {
    attachTo: document.body,
    props: { location: scope === "session" ? yoloLocation : { machine: yoloLocation.machine } },
    global: { plugins: [pinia, router, i18n], stubs: { AgentConfigurationSelector: true } },
  })
  const agents = useAgentSessionsStore(pinia)
  if (scope === "session") agents.sessions["yolo-session"] = { id: "yolo-session", title: "YOLO confirmation", provider: "codex", archiveState: "active", context: "directory", lifecycle: "ready", lastEventSeq: "0", createdAt: "", updatedAt: "" }
  const setYolo = vi.spyOn(agents, "setYolo").mockImplementation(async (id, value) => {
    if (agents.sessions[id]) agents.sessions[id] = { ...agents.sessions[id], yolo: value }
  })
  const enabled = () => scope === "session" ? !!agents.sessions["yolo-session"]?.yolo : agents.draftYolo
  const page = new DOMWrapper(document.body)
  const toggle = wrapper.get("[data-composer-yolo]")
  try {
    await toggle.trigger("click")
    await flushPromises()
    expect(enabled()).toBe(false)
    expect(setYolo).not.toHaveBeenCalled()
    expect(toggle.attributes("aria-pressed")).toBe("false")
    const dialog = page.get('[role="dialog"]')
    expect(dialog.text()).toContain(i18n.global.t("composer.yoloConfirmation.title"))
    expect(dialog.text()).toContain(i18n.global.t("composer.yoloConfirmation.description"))
    await dialog.findAll("button").find(button => button.text() === i18n.global.t("catalog.cancel"))!.trigger("click")
    await flushPromises()
    expect(page.find('[role="dialog"]').exists()).toBe(false)
    expect(enabled()).toBe(false)
    expect(setYolo).not.toHaveBeenCalled()

    await toggle.trigger("click")
    await flushPromises()
    await page.get('[role="dialog"]').findAll("button").find(button => button.text() === i18n.global.t("composer.yoloConfirmation.confirm"))!.trigger("click")
    await flushPromises()
    expect(enabled()).toBe(true)
    expect(toggle.attributes("aria-pressed")).toBe("true")
    expect(page.find('[role="dialog"]').exists()).toBe(false)
    if (scope === "session") expect(setYolo).toHaveBeenCalledExactlyOnceWith("yolo-session", true)
    else expect(setYolo).not.toHaveBeenCalled()

    await toggle.trigger("click")
    await flushPromises()
    expect(enabled()).toBe(false)
    expect(toggle.attributes("aria-pressed")).toBe("false")
    expect(page.find('[role="dialog"]').exists()).toBe(false)

    await toggle.trigger("click")
    await flushPromises()
    expect(enabled()).toBe(false)
    expect(page.find('[role="dialog"]').exists()).toBe(true)
  } finally {
    wrapper.unmount()
  }
})

test.each(["escape", "session change"])("YOLO confirmation is cancelled by %s", async (action) => {
  pinia = createPinia()
  const wrapper = mount(SessionComposer, {
    attachTo: document.body,
    props: { location: yoloLocation },
    global: { plugins: [pinia, router, i18n], stubs: { AgentConfigurationSelector: true } },
  })
  const agents = useAgentSessionsStore(pinia)
  agents.sessions["yolo-session"] = { id: "yolo-session", title: "YOLO confirmation", provider: "codex", archiveState: "active", context: "directory", lifecycle: "ready", lastEventSeq: "0", createdAt: "", updatedAt: "" }
  const setYolo = vi.spyOn(agents, "setYolo")
  const page = new DOMWrapper(document.body)
  try {
    await wrapper.get("[data-composer-yolo]").trigger("click")
    await flushPromises()
    expect(page.find('[role="dialog"]').exists()).toBe(true)
    if (action === "escape") await page.get('[role="dialog"]').trigger("keydown", { key: "Escape" })
    else await wrapper.setProps({ location: { machine: yoloLocation.machine } })
    await flushPromises()
    expect(page.find('[role="dialog"]').exists()).toBe(false)
    expect(setYolo).not.toHaveBeenCalled()
    expect(agents.sessions["yolo-session"]?.yolo).toBeFalsy()
    expect(agents.draftYolo).toBe(false)
  } finally {
    wrapper.unmount()
  }
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

test("dropping a local file starts uploading immediately, renders a circular progress bar, blocks submission until complete, and reuses the staged URI", async () => {
  let reportProgress!: (transferredBytes: number, totalBytes: number) => void
  let finishUpload!: (result: { path: string; uri: string; name: string; size: number }) => void
  const uploadAttachment = vi.spyOn(platformClient.files!, "uploadAttachment").mockImplementation((_request, options) => {
    reportProgress = (transferredBytes, totalBytes) => options?.onProgress?.({ transferredBytes, totalBytes })
    return new Promise(resolve => { finishUpload = resolve })
  })

  pinia = createPinia()
  const location: WorkspaceLocation = {
    machine: { id: "local-daemon", name: "Host", local: true, online: true, desktop: true, workspaces: [], sessions: [], terminals: [] },
    workspace: { id: workspaceId, name: "DeskFleet", directories: [{ path: "/repo", git: undefined }], sessions: [], terminals: [] },
  }
  const modelValue = ref("Trim this clip")
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
    global: { plugins: [pinia, router, i18n], stubs: { AgentConfigurationSelector: true } },
  })

  try {
    await flushPromises()
    const transfer = new DataTransfer()
    const payload = new Uint8Array(100).fill(7)
    transfer.items.add(new File([payload], "clip.mp4", { type: "video/mp4" }))
    Object.defineProperty(transfer, "types", { value: ["Files"] })
    wrapper.get("textarea").element.dispatchEvent(dragEvent("drop", transfer))
    await flushPromises()
    await vi.waitFor(() => expect(uploadAttachment).toHaveBeenCalledOnce())

    const request = uploadAttachment.mock.calls[0]![0]
    expect(request).toMatchObject({
      target: { kind: "local" },
      draftId: attachments.value[0]?.id,
      name: "clip.mp4",
    })
    expect(request.sessionId).toBeUndefined()

    const progress = wrapper.get("[data-attachment-progress]")
    expect(progress.attributes("role")).toBe("progressbar")
    expect(progress.attributes("aria-valuenow")).toBe("0")
    expect(wrapper.get('[aria-label="Send"]').attributes("disabled")).toBeDefined()

    // Submission via click or Enter is blocked while upload is still in progress
    await wrapper.get('[aria-label="Send"]').trigger("click")
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" })
    await flushPromises()
    expect(submitted).not.toHaveBeenCalled()

    reportProgress(45, 100)
    await flushPromises()
    expect(wrapper.get("[data-attachment-progress]").attributes("aria-valuenow")).toBe("45")

    finishUpload({
      path: `/tmp/.drafts/${request.draftId}/clip.mp4`,
      uri: `file:///tmp/.drafts/${request.draftId}/clip.mp4`,
      name: "clip.mp4",
      size: 100,
    })
    await flushPromises()

    expect(wrapper.find("[data-attachment-progress]").exists()).toBe(false)
    expect(wrapper.get('[aria-label="Send"]').attributes("disabled")).toBeUndefined()

    await wrapper.get('[aria-label="Send"]').trigger("click")
    expect(submitted).toHaveBeenCalledOnce()

    const blocks = await buildPromptContent({
      draft: modelValue.value,
      attachments: attachments.value,
      sessionId: "30",
      target: { kind: "local" },
      filesApi: platformClient.files,
    })
    expect(uploadAttachment).toHaveBeenCalledOnce()
    expect(blocks).toEqual([
      { type: "resource_link", uri: `file:///tmp/.drafts/${request.draftId}/clip.mp4`, name: "clip.mp4", mimeType: "video/mp4", size: 100 },
      { type: "text", text: "Trim this clip" },
    ])
  } finally {
    wrapper.unmount()
  }
})

test("removing an uploading attachment aborts the upload and retrying a failed upload unblocks submission", async () => {
  let activeSignal: AbortSignal | undefined
  let rejectFirst!: (error: Error) => void
  let attempt = 0
  vi.spyOn(platformClient.files!, "uploadAttachment").mockImplementation((request, options) => {
    attempt += 1
    activeSignal = options?.signal
    if (attempt === 1) {
      return new Promise((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Upload cancelled", "AbortError")), { once: true })
      })
    }
    if (attempt === 2) {
      return new Promise((_, reject) => { rejectFirst = reject })
    }
    return Promise.resolve({
      path: `/tmp/.drafts/${request.draftId}/${request.name}`,
      uri: `file:///tmp/.drafts/${request.draftId}/${request.name}`,
      name: request.name,
      size: request.data.byteLength,
    })
  })

  pinia = createPinia()
  const location: WorkspaceLocation = {
    machine: { id: "local-daemon", name: "Host", local: true, online: true, desktop: true, workspaces: [], sessions: [], terminals: [] },
    workspace: { id: workspaceId, name: "DeskFleet", directories: [{ path: "/repo", git: undefined }], sessions: [], terminals: [] },
  }
  const attachments = ref<ComposerAttachment[]>([])
  const wrapper = mount(SessionComposer, {
    props: {
      location,
      modelValue: "Edit video",
      attachments: attachments.value,
      "onUpdate:attachments": (value: ComposerAttachment[]) => {
        attachments.value = value
        void wrapper.setProps({ attachments: value })
      },
    },
    global: { plugins: [pinia, router, i18n], stubs: { AgentConfigurationSelector: true } },
  })

  try {
    await flushPromises()
    const dropFile = async (name: string) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(["video-bytes"], name, { type: "video/mp4" }))
      Object.defineProperty(transfer, "types", { value: ["Files"] })
      wrapper.get("textarea").element.dispatchEvent(dragEvent("drop", transfer))
      await flushPromises()
    }

    await dropFile("first.mp4")
    await vi.waitFor(() => expect(activeSignal).toBeDefined())
    const firstSignal = activeSignal!
    expect(firstSignal.aborted).toBe(false)
    await wrapper.get(`[aria-label="${i18n.global.t("composer.removeAttachment", { name: "first.mp4" })}"]`).trigger("click")
    await flushPromises()
    expect(firstSignal.aborted).toBe(true)
    expect(attachments.value).toHaveLength(0)

    await dropFile("second.mp4")
    await vi.waitFor(() => expect(attempt).toBe(2))
    rejectFirst(new Error("Mux send interrupted"))
    await flushPromises()

    expect(wrapper.find("[data-attachment-retry]").exists()).toBe(true)
    expect(wrapper.get('[aria-label="Send"]').attributes("disabled")).toBeDefined()

    await wrapper.get("[data-attachment-retry]").trigger("click")
    await flushPromises()

    expect(attempt).toBe(3)
    expect(wrapper.find("[data-attachment-retry]").exists()).toBe(false)
    expect(wrapper.get('[aria-label="Send"]').attributes("disabled")).toBeUndefined()
  } finally {
    wrapper.unmount()
  }
})
