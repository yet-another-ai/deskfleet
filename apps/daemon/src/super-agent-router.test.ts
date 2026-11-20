import assert from "node:assert/strict"
import { test } from "node:test"
import { hasExplicitResumeIntent, routeSuperMessage, superCandidateCards, type SuperRouteContext } from "./super-agent-router.ts"
import { describeSuperModelFailure, superDecisionInstructions, superDecisionSchema } from "./super-agent-model.ts"

function context(text: string): SuperRouteContext {
  return { workspaceId: "ws-A", text,
    focusTicketId: "T17", recentTicketIds: ["T17", "T23"], recent: [{ role: "assistant", text: "选令牌缓存还是延迟获取？", ticketId: "T17" },
      { role: "worker", text: "首页耗时任务结束", ticketId: "T23" }],
    workspaces: [{ id: "ws-A", name: "A" }, { id: "ws-B", name: "B" }], providers: [{ id: "cx", name: "Codex" }],
    tickets: [{ id: "T17", title: "登录回调慢", scope: "修复重复请求 token", status: "working" },
      { id: "T23", title: "首页首屏慢", scope: "修复页面首屏", status: "working" }],
    pendingQuestion: { ticketId: "T17", optionDisposition: "continue", options: ["令牌缓存", "延迟获取"] }, history: [{ id: "old", title: "历史登录排查" }] }
}
const decide = (actions: object[]) => ({ reason: "fixture routing evidence", actions })

test("provider failures classify gateway outages without storing raw endpoints or credentials", () => {
  const note = describeSuperModelFailure("503 Unable to connect to private.example?token=private-value")
  assert.match(note, /temporarily unavailable/u)
  assert.doesNotMatch(note, /private/u)
  assert.match(describeSuperModelFailure("API Error: 401 invalid token"), /sign-in/u)
  assert.match(describeSuperModelFailure("API Error: 429"), /quota/u)
})

test("only an exact foreground choice bypasses model routing, with or without a quote", async () => {
  for (const quote of [undefined, { text: "选令牌缓存还是延迟获取？", ticketId: "T17" }]) {
    const ctx = { ...context("2"), quote }
    const result = await routeSuperMessage(ctx, { model: async () => { throw new Error("unexpected call") } })
    assert.deepEqual(result.actions, [{ kind: "continue", ticketId: "T17", prompt: "2\n\nSelected option: 延迟获取", delivery: "backlog" }])
  }
  const expired = { ...context("2"), focusTicketId: "T23" }
  const result = await routeSuperMessage(expired, { model: async () => decide([{ kind: "clarify", text: "是哪一个问题的第二种？" }]) })
  assert.equal(result.actions[0]?.kind, "clarify")
  const scopeChoice = { ...context("2"), pendingQuestion: { ticketId: "T17", options: ["只诊断", "实施修复"] } }
  const implementation = await routeSuperMessage(scopeChoice, { model: async () => decide([{ kind: "create", title: "实施修复", scope: "落实诊断建议", prompt: "实施修复", ticketId: "T17" }]) })
  assert.equal(implementation.actions[0]?.kind, "create")
})

test("free text retains all ticket titles including old synonyms without making a worker notification foreground", async () => {
  const ctx = context("上个月苹果公证用的哪个证书？")
  ctx.tickets.push(...Array.from({ length: 40 }, (_, n) => ({ id: `old${n}`, title: `安装包事项 ${n}`, scope: "打包" })))
  ctx.tickets[30]!.title = "安装包签名失败"
  ctx.tickets[30]!.summary = "Verifier: Developer ID Application"
  let calls = 0
  const result = await routeSuperMessage(ctx, { model: async packet => {
    assert.equal((packet.directory as object[]).length, 42)
    assert.ok(!(packet.recent as { role: string }[]).some(row => row.role === "worker"))
    if (++calls === 1) return decide([{ kind: "evidence", request: { kind: "ticket", ticketId: ctx.tickets[30]!.id } }])
    assert.match(JSON.stringify(packet.evidence), /Developer ID Application/u)
    return decide([{ kind: "answer", ticketId: ctx.tickets[30]!.id, text: "Developer ID Application" }])
  } })
  assert.equal(result.actions[0]?.kind, "answer")
  assert.equal(calls, 2)
  assert.ok(superCandidateCards(ctx).length < ctx.tickets.length)
})

test("Chinese phrases without spaces can shortlist older tickets by a distinctive entity", () => {
  const ctx = context("打包之后的证书过期还能刷新吗")
  ctx.tickets.push(...Array.from({ length: 40 }, (_, i) => ({ id: `archive-${i}`, title: `打包事项 ${i}`, scope: "输出产物" })))
  ctx.tickets.at(-1)!.summary = "安装包的证书过期，已经重新签名"
  const cards = superCandidateCards(ctx)
  assert.ok(cards.some(ticket => ticket.id === "archive-39"))
  assert.ok(cards.length < 10)
})

test("a new deliverable or newly authorized implementation may reference a previous ticket without appending to its session", async () => {
  for (const text of ["另外写成客服 FAQ", "刚才只让诊断，现在落实第二种修复"]) {
    const ctx = { ...context(text), quote: { text: "发现重复请求", ticketId: "T17" } }
    const result = await routeSuperMessage(ctx, { model: async () => decide([{ kind: "create", title: "新委托", scope: text, prompt: text, ticketId: "T17" }]) })
    assert.equal(result.actions[0]?.kind, "create")
    assert.ok(result.actions[0]?.kind === "create" && result.actions[0].sessionId === undefined)
  }
})

test("a same-artifact follow-up carries amended acceptance alongside the original authority", async () => {
  const ctx = context("将第二行改为 NEXT，其他行和文件都不动")
  ctx.tickets[0] = { id: "T17", title: "result.txt", scope: "Edit only result.txt. Initial value PASSED.",
    latestAcceptance: "第一行 PASSED，第二行 WAIT。", sessionId: "same-session" }
  const accepted = "第一行保持 PASSED，第二行 NEXT，其他行与文件不动。"
  const { actions } = await routeSuperMessage(ctx, { model: async input => {
    assert.match(JSON.stringify(input.cards), /Edit only result\.txt/u)
    assert.match(JSON.stringify(input.directory), /第二行 WAIT/u)
    return decide([{ kind: "continue", ticketId: "T17", prompt: ctx.text, acceptanceUpdate: accepted }])
  } })
  assert.equal(actions.length, 1)
  assert.equal(actions[0]?.kind === "continue" && actions[0].acceptanceUpdate, accepted)
})

test("unknown model IDs cannot authorize evidence, handoff or dispatch", async () => {
  const actions = [{ kind: "continue", ticketId: "foreign", prompt: "改" },
    { kind: "evidence", request: { kind: "read", workspaceId: "foreign", rootIndex: 0, path: "README.md" } },
    { kind: "handoff", workspaceId: "ws-A", prompt: "改", context: "plan" }]
  for (const action of actions) {
    let calls = 0
    await assert.rejects(routeSuperMessage(context("改"), { model: async () => { calls++; return decide([action]) },
      evidence: async () => assert.fail("unauthorized read") }), /Invalid Super Agent decision/u)
    assert.equal(calls, 2)
  }
})

test("reuse of old sessions requires a successful scoped history read; source handoff retains the user's exact message", async () => {
  const ctx = context("按第二种改，先不提交")
  const create = { kind: "create", title: "修复", scope: "改但不提交", prompt: ctx.text, sessionId: "old" }
  let turns = 0
  const result = await routeSuperMessage(ctx, { evidence: async request => {
    assert.deepEqual(request, { kind: "history", sessionId: "old", afterSeq: undefined }); return JSON.stringify({ messages: [{ text: "修复登录但不提交" }] })
  }, model: async () => decide(++turns === 1 ? [{ kind: "evidence", request: { kind: "history", sessionId: "old" } }] : [create]) })
  assert.equal(result.actions[0]?.kind, "create")
  await assert.rejects(routeSuperMessage(ctx, { model: async () => decide([create]) }), /Read the history/u)
  let emptyTurns = 0
  await assert.rejects(routeSuperMessage(ctx, { evidence: async () => JSON.stringify({ messages: [] }),
    model: async () => decide(++emptyTurns === 1 ? [{ kind: "evidence", request: { kind: "history", sessionId: "old" } }] : [create]) }), /Read the history/u)
  const handoff = await routeSuperMessage(ctx, { model: async () => decide([{ kind: "handoff", workspaceId: "ws-B", context: "第二种 = 延迟获取", prompt: "丢失原限制" }]) })
  assert.equal(handoff.actions[0]?.kind === "handoff" && handoff.actions[0].prompt, ctx.text)
})

test("a clarification or evidence batch cannot dispatch half of an uncertain request", async () => {
  await assert.rejects(routeSuperMessage(context("慢的那个先停"), { model: async () => decide([
    { kind: "stop", ticketId: "T17", prompt: "暂停" }, { kind: "clarify", text: "T17 还是 T23？" },
  ]) }), /Clarifications and handoffs/u)
  const result = await routeSuperMessage(context("慢的那个先停"), { model: async () => decide([{ kind: "clarify", text: "登录回调还是首页首屏？" }]) })
  assert.equal(result.actions.length, 1)
})

test("read-only explanations gather evidence and answer directly while explicit verification dispatches a worker", async () => {
  assert.match(superDecisionInstructions, /never dispatch a worker merely to gather facts/iu)
  assert.match(superDecisionInstructions, /distinguish static analysis from live verification/iu)
  assert.match(superDecisionInstructions, /reports dispatch only after delivery succeeds/iu)
  assert.match(superDecisionInstructions, /similar topic or a ticket merely being in focus/iu)
  assert.match(superDecisionInstructions, /resumeStopped=true/u)
  assert.match(JSON.stringify(superDecisionSchema), /"resumeStopped"/u)

  const reads: unknown[] = []
  let calls = 0
  const explanation = await routeSuperMessage(context("为什么登录回调会重复请求 token？"), {
    evidence: async req => { reads.push(req); return JSON.stringify({ path: "src/login.ts", firstLine: 1, text: "fetchToken() called twice" }) },
    model: async packet => ++calls === 1
      ? decide([{ kind: "evidence", request: { kind: "read", workspaceId: "ws-A", rootIndex: 0, path: "src/login.ts" } }])
      : decide([{ kind: "answer", text: `基于静态代码读取（未实际运行验证）：${JSON.stringify(packet.evidence)}` }]),
  })
  assert.equal(reads.length, 1)
  assert.equal(explanation.actions.length, 1)
  assert.equal(explanation.actions[0]?.kind, "answer")

  const verified = await routeSuperMessage(context("帮我实际跑一下登录回调单测并验证修复效果"), {
    model: async () => decide([{ kind: "create", title: "实测登录回调单测", scope: "运行单测并回报实测结果", prompt: "运行登录回调单测并验证" }]),
  })
  assert.equal(verified.actions.length, 1)
  assert.equal(verified.actions[0]?.kind, "create")
})

test("ambiguous continuation candidates clarify without arming the option fast path", async () => {
  const ctx: SuperRouteContext = {
    ...context("把慢的那个接口再优化一下"),
    pendingQuestion: undefined,
    recent: [{ role: "user", text: "登录回调和首页首屏都很慢" }],
  }
  const clarified = await routeSuperMessage(ctx, {
    model: async () => decide([{ kind: "clarify", text: "你要继续哪一个事项？", options: ["登录回调慢", "首页首屏慢"] }]),
  })
  assert.equal(clarified.actions[0]?.kind, "clarify")
  assert.equal(clarified.actions[0]?.kind === "clarify" && clarified.actions[0].optionDisposition, undefined)

  let modelCalled = false
  const followUp = await routeSuperMessage({
    ...ctx, text: "1", pendingQuestion: { ticketId: "T17", options: ["登录回调慢", "首页首屏慢"] },
  }, {
    model: async () => {
      modelCalled = true
      return decide([{ kind: "continue", ticketId: "T17", prompt: "优化登录回调慢" }])
    },
  })
  assert.equal(modelCalled, true)
  assert.equal(followUp.actions[0]?.kind, "continue")
})

test("stopped tickets block implicit reopening in code across regular routing and exactOption while allowing explicit resume and normal completed follow-ups", async () => {
  for (const phrase of ["恢复这个事项", "把登录回调排查重跑一下", "重新执行 T17", "再跑一遍", "把刚才停掉的继续跑", "能不能帮我恢复这个事项？", "Please resume this ticket", "re-run the check", "run it again"]) {
    assert.equal(hasExplicitResumeIntent(phrase), true, phrase)
  }
  for (const phrase of ["刚才为什么停了？", "登录回调还有个边界问题", "继续", "2", "延迟获取", "好的", "不要恢复，先解释原因", "别把刚才停掉的任务重跑", "为什么没有恢复？", "要不要重跑？", "Don't resume it", "do not rerun this task", "Why didn't it resume?"]) {
    assert.equal(hasExplicitResumeIntent(phrase), false, phrase)
  }

  const stoppedCtx = (text: string): SuperRouteContext => ({
    ...context(text),
    tickets: [
      { id: "T17", title: "登录回调慢", scope: "修复重复请求 token", status: "stopped" },
      { id: "T23", title: "首页首屏慢", scope: "修复页面首屏" },
    ],
  })

  // Quick-continue shortcut (exactOption) must not bypass the model for a stopped ticket.
  let shortcutCalls = 0
  const blockedShortcut = await routeSuperMessage(stoppedCtx("2"), {
    model: async packet => {
      if (++shortcutCalls === 1) return decide([{ kind: "continue", ticketId: "T17", prompt: "2", resumeStopped: true }])
      assert.match(String(packet.validationError), /stopped ticket/iu)
      return decide([{ kind: "clarify", text: "「登录回调慢」已被停止。需要恢复并重跑它，还是另开一个新事项？" }])
    },
  })
  assert.equal(shortcutCalls, 2)
  assert.equal(blockedShortcut.actions[0]?.kind, "clarify")

  // Stopped ticket cannot pre-authorize optionDisposition="continue".
  await assert.rejects(routeSuperMessage(stoppedCtx("怎么处理？"), {
    model: async () => decide([{ kind: "clarify", ticketId: "T17", text: "选哪项？", options: ["恢复", "新开"], optionDisposition: "continue" }]),
  }), /Stopped tickets cannot pre-authorize/u)

  // Ordinary discussion fails closed if the model insists on reopening the stopped ticket.
  let discussionCalls = 0
  await assert.rejects(routeSuperMessage({ ...stoppedCtx("刚才为什么停了？"), quote: { text: "已停止", ticketId: "T17" } }, {
    model: async () => { discussionCalls++; return decide([{ kind: "continue", ticketId: "T17", prompt: "回答原因", resumeStopped: true }]) },
  }), /Cannot reopen a stopped ticket/u)
  assert.equal(discussionCalls, 2)

  // Explicit resume request succeeds (and nudges resumeStopped: true if omitted on pass 1).
  let resumeCalls = 0
  const resumed = await routeSuperMessage(stoppedCtx("恢复刚才停掉的登录回调排查"), {
    model: async packet => {
      if (++resumeCalls === 1) return decide([{ kind: "continue", ticketId: "T17", prompt: "恢复登录回调排查" }])
      assert.match(String(packet.validationError), /resumeStopped: true/u)
      return decide([{ kind: "continue", ticketId: "T17", prompt: "恢复登录回调排查", resumeStopped: true }])
    },
  })
  assert.equal(resumeCalls, 2)
  assert.deepEqual(resumed.actions, [{ kind: "continue", ticketId: "T17", prompt: "恢复登录回调排查", acceptanceUpdate: undefined, delivery: undefined, resumeStopped: true }])

  // Selecting an explicit resume option from a post-stop clarification question also succeeds.
  const resumedByChoice = await routeSuperMessage({
    ...stoppedCtx("1"),
    pendingQuestion: { ticketId: "T17", options: ["恢复并重跑「登录回调慢」", "另开一个新事项"] },
  }, {
    model: async () => decide([{ kind: "continue", ticketId: "T17", prompt: "恢复并重跑登录回调慢", resumeStopped: true }]),
  })
  assert.equal(resumedByChoice.actions[0]?.kind, "continue")

  // A normally completed ticket (status: undefined) continues under existing rules without resume keywords.
  const completed = await routeSuperMessage({
    ...stoppedCtx("把首页首屏的第二项文案改短一点"),
    focusTicketId: "T23",
    quote: { text: "首页首屏优化完成", ticketId: "T23" },
  }, {
    model: async () => decide([{ kind: "continue", ticketId: "T23", prompt: "把首页首屏的第二项文案改短一点" }]),
  })
  assert.equal(completed.actions[0]?.kind, "continue")
  assert.equal(completed.actions[0]?.kind === "continue" && completed.actions[0].ticketId, "T23")
})
