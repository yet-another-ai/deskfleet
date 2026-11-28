import type { SuperAgentApi } from "@deskfleet/client/desktop-api"
import { getClient } from "@deskfleet/client/platform"
import type { ComposerMention } from "@deskfleet/protocol/composer-reference"
import type { SuperMessage, SuperSnapshot, SuperTicket } from "@deskfleet/protocol/super-agent"
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { ref } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { accountSessionKey } from "../composables/useAccountSession.ts"
import { platformClientKey } from "../composables/usePlatformClient.ts"
import { i18n } from "../i18n/index.ts"
import { useWorkspaceAgentDrafts } from "../stores/workspace-agent-drafts.ts"
import WorkspaceAgentView from "./WorkspaceAgentView.vue"

const makeTicket = (id: string, extra: Partial<SuperTicket> = {}): SuperTicket => ({
  id,
  title: id,
  scope: id,
  summary: "",
  provider: "codex",
  updatedAt: "2026-11-28T00:00:00.000Z",
  ...extra,
})

const makeMessage = (id: string, extra: Partial<SuperMessage> = {}): SuperMessage => ({
  id,
  role: "user",
  text: id,
  createdAt: "2026-11-28T00:00:00.000Z",
  ...extra,
})

const makeRoom = (extra: Partial<SuperSnapshot> = {}): SuperSnapshot => ({
  workspaceId: "ws-reedit",
  provider: "codex",
  supportsStop: true,
  supportsAttachments: true,
  supportsAttachmentPreviews: true,
  supportsComposerMentions: true,
  supportsStoppedReEdit: true,
  tickets: [],
  messages: [],
  ...extra,
})

let wrappers: VueWrapper[] = []
let pinia: ReturnType<typeof createPinia> | undefined
const originalLocale = i18n.global.locale.value

async function setup(initial: SuperSnapshot, options: {
  ios?: boolean
  locale?: "zh-cmn-Hans-CN" | "en-US"
  userId?: string
} = {}) {
  i18n.global.locale.value = options.locale ?? "zh-cmn-Hans-CN"
  let state = initial
  const machines = ref([{ id: "local-daemon", teamId: "team-reedit", name: "Studio Mac", online: true }])
  const api = {
    snapshot: vi.fn<SuperAgentApi["snapshot"]>(async ({ attachment }) => {
      if (attachment) {
        return {
          ...state,
          attachmentPreview: {
            ...attachment,
            content: attachment.index === 0
              ? { type: "image", mimeType: "image/png", data: "iVBORw==" }
              : { type: "resource", text: "pasted log snippet" },
          },
        }
      }
      return state
    }),
    stop: vi.fn<NonNullable<SuperAgentApi["stop"]>>(async () => state),
    send: vi.fn<SuperAgentApi["send"]>(async request => {
      const reusedInfos = (request.reusedAttachments ?? []).flatMap(refItem => {
        const src = state.messages.find(m => m.id === refItem.messageId)
        const info = src?.attachments?.[refItem.index]
        return info ? [info] : []
      })
      state = {
        ...state,
        messages: [
          ...state.messages,
          makeMessage(request.messageId, {
            text: request.text,
            replyTo: request.replyTo,
            reEditOf: request.reEditOf,
            mentions: request.mentions,
            ...(reusedInfos.length ? { attachments: reusedInfos } : {}),
            state: "routing",
          }),
        ],
      }
      return state
    }),
    correct: vi.fn<SuperAgentApi["correct"]>(async () => state),
    settings: vi.fn<SuperAgentApi["settings"]>(async () => state),
  } satisfies SuperAgentApi
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "new-session", component: {} },
      { path: "/workspaces/:workspaceId/agent", name: "workspace-agent", component: {} },
      { path: "/sessions/:sessionId", name: "session", component: {} },
      { path: "/settings/agents", name: "settings-agents", component: {} },
    ],
  })
  await router.push(initial.workspaceId ? { name: "workspace-agent", params: { workspaceId: initial.workspaceId } } : "/")
  const localPinia = createPinia()
  pinia = localPinia
  const userId = options.userId ?? `user-${crypto.randomUUID()}`
  const wrapper = mount(WorkspaceAgentView, {
    props: { api, workspaceId: initial.workspaceId },
    attachTo: document.body,
    global: {
      plugins: [localPinia, i18n, router],
      provide: {
        ...(options.ios && { [platformClientKey as symbol]: { ...getClient(), platform: "web", mobile: true, remoteWorkspaceAgent: true } }),
        [accountSessionKey as symbol]: {
          account: ref({ user: { id: userId, name: "Tester", email: "tester@example.test" } }),
          members: ref([]),
          teamId: ref("team-reedit"),
          localMachineId: ref("local-daemon"),
          machineId: ref("local-daemon"),
          machines,
        },
      },
      stubs: {
        PaneHeader: { template: '<header><slot/><slot name="actions"/></header>' },
        AgentMarkdown: { props: ["text"], template: "<span>{{ text }}</span>" },
      },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, api, pinia: localPinia, update: (next: SuperSnapshot) => { state = next } }
}

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers = []
  if (pinia) disposePinia(pinia)
  pinia = undefined
  i18n.global.locale.value = originalLocale
  sessionStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test("offers re-edit and fold only beside confirmed stopped turns and never for routing, stopping, unconfirmed, partial-split, or unassociated records", async () => {
  const tStopped = makeTicket("t-stopped", { status: "stopped" })
  const tRunning = makeTicket("t-running", { status: "working" })
  const initial = makeRoom({
    tickets: [tStopped, tRunning],
    messages: [
      makeMessage("u-routing", { state: "routing", text: "正在路由" }),
      makeMessage("u-stopping", { state: "assigned", ticketId: tRunning.id, text: "正在停止" }),
      makeMessage("d-stopping", { role: "assistant", kind: "dispatch", sourceMessageId: "u-stopping", ticketId: tRunning.id, stopState: "stopping" }),
      makeMessage("u-unconfirmed", { state: "assigned", ticketId: tRunning.id, text: "未确认停止" }),
      makeMessage("d-unconfirmed", { role: "assistant", kind: "dispatch", sourceMessageId: "u-unconfirmed", ticketId: tRunning.id, stopState: "unconfirmed" }),
      makeMessage("u-partial", { state: "assigned", text: "仅一半停止" }),
      makeMessage("d-partial-1", { role: "assistant", kind: "dispatch", sourceMessageId: "u-partial", ticketId: tStopped.id, stopState: "stopped" }),
      makeMessage("d-partial-2", { role: "assistant", kind: "dispatch", sourceMessageId: "u-partial", ticketId: tRunning.id, canStop: true }),
      makeMessage("u-stopped-route", { state: "stopped", text: "路由已停止" }),
      makeMessage("u-stopped-worker", { state: "assigned", ticketId: tStopped.id, text: "执行已停止" }),
      makeMessage("d-stopped-worker", { role: "assistant", kind: "dispatch", sourceMessageId: "u-stopped-worker", ticketId: tStopped.id, stopState: "stopped" }),
      makeMessage("w-stopped-worker", { role: "worker", workerEvent: "result", sourceMessageId: "u-stopped-worker", ticketId: tStopped.id, stopState: "stopped", text: "部分输出" }),
      makeMessage("w-orphan-stopped", { role: "worker", workerEvent: "result", ticketId: tStopped.id, stopState: "stopped", text: "无来源的已停止记录" }),
    ],
  })

  const { wrapper } = await setup(initial)

  expect(wrapper.find('[data-reedit-stopped-turn="u-stopped-route"]').exists()).toBe(true)
  expect(wrapper.find('[data-fold-stopped-turn="u-stopped-route"]').exists()).toBe(true)
  expect(wrapper.find('[data-reedit-stopped-turn="u-stopped-worker"]').exists()).toBe(true)
  expect(wrapper.find('[data-fold-stopped-turn="u-stopped-worker"]').exists()).toBe(true)

  for (const excluded of ["u-routing", "u-stopping", "u-unconfirmed", "u-partial", "w-orphan-stopped"]) {
    expect(wrapper.find(`[data-reedit-stopped-turn="${excluded}"]`).exists()).toBe(false)
    expect(wrapper.find(`[data-fold-stopped-turn="${excluded}"]`).exists()).toBe(false)
  }
  expect(wrapper.text()).not.toContain("撤回并编辑")
  expect(wrapper.text()).not.toContain("停止并编辑")
})

test.each([false, true])("restores original text, attachments, quote and mentions into composer and focuses without sending or mutating (mobile=%s)", async ios => {
  const mention: ComposerMention = {
    id: "m-file",
    token: "@src/app.ts",
    start: 3,
    end: 14,
    reference: {
      kind: "file",
      originId: "origin-1",
      workspaceId: "ws-reedit",
      directoryIndex: 0,
      sourceDirectory: "/repo",
      relativePath: "src/app.ts",
    },
  }
  const initial = makeRoom({
    messages: [
      makeMessage("u-ref", { role: "assistant", text: "之前的讨论方案" }),
      makeMessage("u-stopped", {
        text: "请看 @src/app.ts 并增加改名功能",
        replyTo: "u-ref",
        mentions: [mention],
        attachments: [
          { type: "image", name: "image/png" },
          { type: "resource", name: "text/plain" },
          { type: "resource_link", name: "design.pdf" },
        ],
        state: "stopped",
      }),
    ],
  })

  const { wrapper, api } = await setup(initial, { ios })
  const textarea = wrapper.get<HTMLTextAreaElement>("[data-composer-input]")

  await wrapper.get('[data-reedit-stopped-turn="u-stopped"]').trigger("click")
  await flushPromises()

  expect(textarea.element.value).toBe("请看 @src/app.ts 并增加改名功能")
  expect(document.activeElement).toBe(textarea.element)
  expect(wrapper.get("[data-composer-quote]").text()).toContain("之前的讨论方案")
  const banner = wrapper.get("[data-composer-reedit-banner]")
  expect(banner.attributes("data-reedit-source")).toBe("u-stopped")
  expect(banner.get("[data-reedit-status-hint]").text()).toBe("正在修改已停止的指令")
  // No duplicate original instruction preview and no permanent visible hint paragraph
  expect(banner.text()).not.toContain("请看 @src/app.ts")
  expect(new DOMWrapper(document.body).find("[data-reedit-hint-tooltip]").exists()).toBe(false)
  // Low-emphasis right button displays "退出" with explicit accessible name "退出重新编辑"
  const exitButton = banner.get("[data-cancel-reedit]")
  expect(exitButton.text()).toBe("退出")
  expect(exitButton.attributes("aria-label")).toBe("退出重新编辑")
  // Auxiliary hint is exposed to assistive tech via aria-describedby and appears on keyboard focus
  const statusTrigger = banner.get("[data-reedit-status-hint]")
  expect(statusTrigger.attributes("tabindex")).toBe("0")
  const describedBy = statusTrigger.attributes("aria-describedby")
  expect(describedBy).toBeTruthy()
  expect(banner.get(`#${describedBy}`).text()).toBe("修改后手动发送，不会恢复旧任务或回滚文件")
  await statusTrigger.trigger("focus")
  await flushPromises()
  expect(new DOMWrapper(document.body).get('[data-reedit-hint-tooltip] [role="tooltip"]').text()).toBe("修改后手动发送，不会恢复旧任务或回滚文件")
  await statusTrigger.trigger("keydown", { key: "Escape" })
  await flushPromises()
  expect(new DOMWrapper(document.body).find("[data-reedit-hint-tooltip]").exists()).toBe(false)
  await statusTrigger.trigger("focus")
  await flushPromises()
  expect(new DOMWrapper(document.body).find("[data-reedit-hint-tooltip]").exists()).toBe(true)
  await statusTrigger.trigger("blur")
  await flushPromises()
  expect(new DOMWrapper(document.body).find("[data-reedit-hint-tooltip]").exists()).toBe(false)

  const chips = wrapper.findAll("[data-composer-attachments] [data-attachment-kind='stored_workspace']")
  expect(chips).toHaveLength(3)
  expect(chips[0]!.get("img").attributes("src")).toBe("data:image/png;base64,iVBORw==")
  expect(chips[1]!.text()).toContain(i18n.global.t("composer.pastedText"))
  expect(chips[2]!.text()).toContain("design.pdf")

  const mentionChips = wrapper.findAll("[data-composer-mentions] li")
  expect(mentionChips).toHaveLength(1)
  expect(mentionChips[0]!.text()).toContain("@src/app.ts")

  expect(api.send).not.toHaveBeenCalled()
  expect(api.stop).not.toHaveBeenCalled()
  expect(api.correct).not.toHaveBeenCalled()
})

test("protects existing text, attachment-only, and quote-only drafts from silent overwrite and prevents loss on cancel", async () => {
  const initial = makeRoom({
    messages: [
      makeMessage("u-quote-target", { role: "assistant", text: "被引用消息 A" }),
      makeMessage("u-stopped", { text: "需要重新编辑的旧指令", state: "stopped" }),
    ],
  })

  // Case A: Text-only draft -> cancel dialog preserves draft
  {
    const { wrapper } = await setup(initial)
    const textarea = wrapper.get<HTMLTextAreaElement>("[data-composer-input]")
    await textarea.setValue("正在写的草稿")
    await wrapper.get('[data-reedit-stopped-turn="u-stopped"]').trigger("click")
    await flushPromises()

    const dialog = new DOMWrapper(document.body).get('[role="dialog"]')
    expect(dialog.text()).toContain(i18n.global.t("superAgent.reEdit.confirmStashTitle"))
    expect(textarea.element.value).toBe("正在写的草稿")
    await dialog.get("[data-confirm-cancel]").trigger("click")
    await flushPromises()

    expect(textarea.element.value).toBe("正在写的草稿")
    expect(wrapper.find("[data-composer-reedit-banner]").exists()).toBe(false)
  }

  // Case B: Attachment-only draft (empty text) -> protected, stashed, and restored when abandoning unmodified re-edit
  {
    const { wrapper, pinia: localPinia } = await setup(initial)
    const drafts = useWorkspaceAgentDrafts(localPinia)
    const key = JSON.stringify("ws-reedit")
    drafts.files[key] = [{ id: "img-draft", kind: "image", name: "draft.png", mimeType: "image/png", data: "iVBORw==", size: 8 }]
    drafts.get("ws-reedit").attachmentLabels = [{ id: "img-draft", name: "draft.png" }]
    await flushPromises()

    await wrapper.get('[data-reedit-stopped-turn="u-stopped"]').trigger("click")
    await flushPromises()
    const dialog = new DOMWrapper(document.body).get('[role="dialog"]')
    expect(dialog.text()).toContain(i18n.global.t("superAgent.reEdit.confirmStashTitle"))
    await dialog.findAll("button").find(b => b.text() === i18n.global.t("superAgent.reEdit.confirmStashAction"))!.trigger("click")
    await flushPromises()

    expect(wrapper.get<HTMLTextAreaElement>("[data-composer-input]").element.value).toBe("需要重新编辑的旧指令")
    expect(wrapper.find("[data-reedit-stashed-badge]").exists()).toBe(true)

    // Abandon unmodified re-edit -> restores attachment-only draft!
    await wrapper.get("[data-cancel-reedit]").trigger("click")
    await flushPromises()
    expect(wrapper.get<HTMLTextAreaElement>("[data-composer-input]").element.value).toBe("")
    expect(wrapper.find('[data-composer-attachments] [data-attachment-kind="image"]').text()).toContain("draft.png")
    expect(wrapper.find("[data-folded-stopped-turn]").exists()).toBe(false)
  }

  // Case C: Quote-only draft (empty text, no attachments) -> protected, stashed, and modified abandon offers explicit choice
  {
    const { wrapper, api } = await setup(initial)
    await wrapper.get('[data-super-message="u-quote-target"] button[aria-label="引用"]').trigger("click")
    await flushPromises()
    expect(wrapper.get("[data-composer-quote]").text()).toContain("被引用消息 A")

    await wrapper.get('[data-reedit-stopped-turn="u-stopped"]').trigger("click")
    await flushPromises()
    const stashDialog = new DOMWrapper(document.body).get('[role="dialog"]')
    expect(stashDialog.text()).toContain(i18n.global.t("superAgent.reEdit.confirmStashTitle"))
    await stashDialog.findAll("button").find(b => b.text() === i18n.global.t("superAgent.reEdit.confirmStashAction"))!.trigger("click")
    await flushPromises()

    // Modify re-edit text then click cancel -> explicit choice dialog prevents silent loss of either version
    const textarea = wrapper.get<HTMLTextAreaElement>("[data-composer-input]")
    await textarea.setValue("改了一半的新内容")
    await wrapper.get("[data-cancel-reedit]").trigger("click")
    await flushPromises()
    const abandonDialog = new DOMWrapper(document.body).get('[role="dialog"]')
    expect(abandonDialog.text()).toContain(i18n.global.t("superAgent.reEdit.confirmAbandonTitle"))

    // Choose "keep current text as draft" -> detaches reEditOf, keeps typed text, sending later does NOT fold u-stopped!
    await abandonDialog.get("[data-reedit-keep-current]").trigger("click")
    await flushPromises()
    expect(textarea.element.value).toBe("改了一半的新内容")
    expect(wrapper.find("[data-composer-reedit-banner]").exists()).toBe(false)

    await wrapper.get(".composer-send").trigger("click")
    await flushPromises()
    expect(api.send).toHaveBeenCalledWith(expect.not.objectContaining({ reEditOf: expect.anything() }))
    expect(wrapper.find('[data-folded-stopped-turn="u-stopped"]').exists()).toBe(false)
  }
})

test("folds old turn into '上一版已停止 · 查看原文与执行记录' only after manual send succeeds, keeps history expandable, and never folds on send failure", async () => {
  const initial = makeRoom({
    supportsReplyFeedback: true,
    messages: [
      makeMessage("u-quote", { role: "assistant", text: "原始背景" }),
      makeMessage("u-stopped", {
        text: "在 Super Agent 的设置项中，增加啊啊啊 给 Super Agent 改名",
        replyTo: "u-quote",
        attachments: [{ type: "resource_link", name: "notes.md" }],
        state: "stopped",
      }),
    ],
    feedback: {
      cursor: 1,
      previewGeneration: "gen-1",
      items: [],
      processes: [{ sourceMessageId: "u-stopped", revision: 0, activityCount: 1, branches: [{ ticketId: "t1", sessionId: "s1", activityCount: 1 }] }],
    },
  })

  const { wrapper, api } = await setup(initial)
  const textarea = wrapper.get<HTMLTextAreaElement>("[data-composer-input]")

  // Existing draft gets stashed and restored after send succeeds
  await textarea.setValue("待会儿要发的草稿")
  await wrapper.get('[data-reedit-stopped-turn="u-stopped"]').trigger("click")
  await flushPromises()
  const stashDialog = new DOMWrapper(document.body).get('[role="dialog"]')
  await stashDialog.findAll("button").find(b => b.text() === i18n.global.t("superAgent.reEdit.confirmStashAction"))!.trigger("click")
  await flushPromises()

  // Edit restored text and trigger send failure first
  await textarea.setValue("在 Super Agent 的设置项中，增加给 Super Agent 改名的功能。")
  const originalSend = api.send.getMockImplementation()!
  api.send.mockRejectedValueOnce(new Error("网络断开"))
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()

  // On failure: must NOT fold old turn, must keep re-edit state and edited content!
  expect(wrapper.get('[role="alert"]').text()).toContain("网络断开")
  expect(wrapper.find('[data-folded-stopped-turn="u-stopped"]').exists()).toBe(false)
  expect(wrapper.find('[data-super-message="u-stopped"]').exists()).toBe(true)
  expect(wrapper.find("[data-composer-reedit-banner]").exists()).toBe(true)
  expect(textarea.element.value).toBe("在 Super Agent 的设置项中，增加给 Super Agent 改名的功能。")

  // Retry manual send -> succeeds!
  api.send.mockImplementationOnce(originalSend)
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()

  expect(api.send).toHaveBeenCalledTimes(2)
  // Same messageId reused for idempotency, with explicit reEditOf + replyTo + reusedAttachments
  expect(api.send.mock.calls[1]![0]).toEqual(api.send.mock.calls[0]![0])
  expect(api.send.mock.calls[1]![0]).toMatchObject({
    workspaceId: "ws-reedit",
    text: "在 Super Agent 的设置项中，增加给 Super Agent 改名的功能。",
    replyTo: "u-quote",
    reEditOf: "u-stopped",
    reusedAttachments: [{ messageId: "u-stopped", index: 0 }],
  })

  // Stashed draft is restored into composer after successful send!
  expect(wrapper.find("[data-composer-reedit-banner]").exists()).toBe(false)
  expect(textarea.element.value).toBe("待会儿要发的草稿")

  // Old stopped turn collapses into exact 1-line summary, revised message stays expanded!
  const folded = wrapper.get('[data-folded-stopped-turn="u-stopped"]')
  expect(folded.attributes("data-folded-stopped-reason")).toBe("superseded")
  const toggle = folded.get("[data-folded-stopped-toggle]")
  expect(toggle.attributes("aria-expanded")).toBe("false")
  expect(toggle.text()).toBe("上一版已停止 · 查看原文与执行记录")
  expect(wrapper.find('[data-super-message="u-stopped"]').exists()).toBe(false)
  expect(wrapper.find('[data-feedback-group-for="u-stopped"]').exists()).toBe(false)

  const revisedMessageId = api.send.mock.calls[1]![0].messageId
  expect(wrapper.get(`[data-super-message="${revisedMessageId}"]`).text()).toContain("在 Super Agent 的设置项中，增加给 Super Agent 改名的功能。")

  // Expand collapsed history -> original prompt, attachment, quote, and 已停止 record are all visible!
  await toggle.trigger("click")
  await flushPromises()
  expect(toggle.attributes("aria-expanded")).toBe("true")
  expect(wrapper.get('[data-super-message="u-stopped"]').text()).toContain("增加啊啊啊")
  expect(wrapper.get('[data-super-message="u-stopped"]').text()).toContain("notes.md")
  expect(wrapper.get('[data-feedback-group-for="u-stopped"]').text()).toContain("已停止")
  // Historical expanded superseded turn has no new re-edit/fold controls inside
  expect(wrapper.find('[data-reedit-stopped-turn="u-stopped"]').exists()).toBe(false)

  // Collapse again
  await toggle.trigger("click")
  await flushPromises()
  expect(toggle.attributes("aria-expanded")).toBe("false")
  expect(wrapper.find('[data-super-message="u-stopped"]').exists()).toBe(false)
})

test("never mis-folds interleaved unrelated turns or manually re-sent adjacent messages, and supports display-only '折叠此轮'", async () => {
  const tOld = makeTicket("t-old", { title: "旧事项", status: "stopped" })
  const tMid = makeTicket("t-mid", { title: "中间事项" })
  const initial = makeRoom({
    tickets: [tOld, tMid],
    messages: [
      makeMessage("u-old", { state: "assigned", ticketId: tOld.id, text: "在 Super Agent 的设置项中，增加啊啊啊 给 Super Agent 改名" }),
      makeMessage("d-old", { role: "assistant", kind: "dispatch", sourceMessageId: "u-old", ticketId: tOld.id, stopState: "stopped" }),
      makeMessage("u-mid", { state: "answered", ticketId: tMid.id, text: "中间插入的无关问题" }),
      makeMessage("a-mid", { role: "assistant", sourceMessageId: "u-mid", ticketId: tMid.id, text: "中间插入的无关回答" }),
      makeMessage("w-old", { role: "worker", workerEvent: "result", sourceMessageId: "u-old", ticketId: tOld.id, stopState: "stopped", text: "旧轮次中途停止的部分记录" }),
      // Adjacent manually sent message with similar text and NO reEditOf
      makeMessage("u-manual", { state: "answered", text: "在 Super Agent 的设置项中，增加给 Super Agent 改名的功能。" }),
    ],
  })

  const { wrapper, api } = await setup(initial)

  // Adjacent manual message must NOT auto-fold u-old
  expect(wrapper.find('[data-folded-stopped-turn="u-old"]').exists()).toBe(false)
  expect(wrapper.find('[data-super-message="u-old"]').exists()).toBe(true)
  expect(wrapper.find('[data-super-message="u-mid"]').exists()).toBe(true)
  expect(wrapper.find('[data-super-message="a-mid"]').exists()).toBe(true)
  expect(wrapper.find('[data-super-message="w-old"]').exists()).toBe(true)
  expect(wrapper.find('[data-super-message="u-manual"]').exists()).toBe(true)

  // Click display-only '折叠此轮' on u-old -> folds ONLY u-old + w-old without calling API or claiming '上一版'
  await wrapper.get('[data-fold-stopped-turn="u-old"]').trigger("click")
  await flushPromises()
  expect(api.send).not.toHaveBeenCalled()
  const manualFolded = wrapper.get('[data-folded-stopped-turn="u-old"]')
  expect(manualFolded.attributes("data-folded-stopped-reason")).toBe("manual")
  expect(manualFolded.text()).toBe("已停止的轮次 · 查看原文与执行记录")
  expect(wrapper.find('[data-super-message="u-old"]').exists()).toBe(false)
  expect(wrapper.find('[data-super-message="w-old"]').exists()).toBe(false)
  // Interleaved unrelated turn and manual message stay completely expanded!
  expect(wrapper.find('[data-super-message="u-mid"]').exists()).toBe(true)
  expect(wrapper.find('[data-super-message="a-mid"]').exists()).toBe(true)
  expect(wrapper.find('[data-super-message="u-manual"]').exists()).toBe(true)

  // Click manually folded row -> unfolds back to full view
  await manualFolded.get("[data-folded-stopped-toggle]").trigger("click")
  await flushPromises()
  expect(wrapper.find('[data-super-message="u-old"]').exists()).toBe(true)
  expect(wrapper.find('[data-super-message="w-old"]').exists()).toBe(true)

  // Now explicitly re-edit u-old and send -> folds ONLY u-old + w-old as superseded; interleaved u-mid/a-mid & u-manual stay untouched!
  await wrapper.get('[data-reedit-stopped-turn="u-old"]').trigger("click")
  await flushPromises()
  await wrapper.get<HTMLTextAreaElement>("[data-composer-input]").setValue("最终通过重新编辑发送的修正版")
  await wrapper.get(".composer-send").trigger("click")
  await flushPromises()

  const superseded = wrapper.get('[data-folded-stopped-turn="u-old"]')
  expect(superseded.attributes("data-folded-stopped-reason")).toBe("superseded")
  expect(superseded.text()).toBe("上一版已停止 · 查看原文与执行记录")
  expect(wrapper.find('[data-super-message="u-old"]').exists()).toBe(false)
  expect(wrapper.find('[data-super-message="w-old"]').exists()).toBe(false)
  expect(wrapper.find('[data-super-message="u-mid"]').exists()).toBe(true)
  expect(wrapper.find('[data-super-message="a-mid"]').exists()).toBe(true)
  expect(wrapper.find('[data-super-message="u-manual"]').exists()).toBe(true)

  // Expand superseded turn -> both u-old and its interleaved stopped worker record w-old appear in history
  await superseded.get("[data-folded-stopped-toggle]").trigger("click")
  await flushPromises()
  expect(wrapper.find('[data-super-message="u-old"]').exists()).toBe(true)
  expect(wrapper.find('[data-super-message="w-old"]').exists()).toBe(true)
  expect(wrapper.get('[data-super-message="w-old"]').text()).toContain("旧轮次中途停止的部分记录")
})

test("on iOS touch, tapping the re-edit banner status hint toggles the tooltip and touch targets meet 44pt sizing", async () => {
  const initial = makeRoom({
    messages: [
      makeMessage("u-stopped", { text: "待重编辑的移动端消息", state: "stopped" }),
    ],
  })
  const { wrapper } = await setup(initial, { ios: true })
  await wrapper.get('[data-reedit-stopped-turn="u-stopped"]').trigger("click")
  await flushPromises()

  const trigger = wrapper.get("[data-reedit-status-hint]")
  expect(trigger.classes()).toContain("min-h-11")
  expect(new DOMWrapper(document.body).find("[data-reedit-hint-tooltip]").exists()).toBe(false)

  await trigger.trigger("click")
  await flushPromises()
  expect(trigger.attributes("aria-expanded")).toBe("true")
  expect(wrapper.get("[data-reedit-hint-tooltip]").text()).toBe("修改后手动发送，不会恢复旧任务或回滚文件")

  await trigger.trigger("click")
  await flushPromises()
  expect(trigger.attributes("aria-expanded")).toBe("false")
  expect(wrapper.find("[data-reedit-hint-tooltip]").exists()).toBe(false)
})
