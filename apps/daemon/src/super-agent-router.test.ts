import assert from "node:assert/strict"
import { test } from "node:test"
import { routeSuperMessage, superCandidateCards, type SuperRouteContext } from "./super-agent-router.ts"
import { describeSuperModelFailure } from "./super-agent-model.ts"

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
