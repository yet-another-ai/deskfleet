/** Real, opt-in semantic replay with synthetic projects. No worker or filesystem evidence is attached. */
import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { routeSuperMessage, type SuperRouteContext, type SuperRouteAction } from "../apps/daemon/src/super-agent-router.ts"

const coordinator = process.argv[2]
if (coordinator !== "codex" && coordinator !== "claude-code") throw new Error("Usage: node scripts/smoke-super-router.ts codex|claude-code")
const base: SuperRouteContext = {
  coordinator, workspaceId: "A", text: "", recent: [],
  workspaces: [{ id: "A", name: "A", rootCount: 1 }, { id: "B", name: "B", rootCount: 1 }],
  focusTicketId: "T17",
  tickets: [
    { id: "T17", title: "登录回调太慢", scope: "允许落实登录加速方案，完成上线前验证", status: "working" },
    { id: "T23", title: "首页首屏太慢", scope: "允许修复首页的资源加载瓶颈", status: "working" },
  ],
}
const options = ["合并请求", "推迟令牌获取"]
const lastQuestion = { role: "assistant" as const, ticketId: "T17", text: "登录优化选第一种合并请求，还是第二种推迟令牌获取？" }
const diagnose = { ...base.tickets[0]!, scope: "只排查并给出两种方案，别改代码，别实施" }
const old = Array.from({length:40}, (_, i) => ({ id: `old-${i}`, title: `打包任务 ${i}`, scope: "构建安装包" }))
old[29] = { id:"sign", title:"安装包签名失败", scope:"修复 macOS 分发签名与 notarization" }
const cert = "Developer ID Application: Synthetic Forge"
type Case = { name: string; ctx: Partial<SuperRouteContext> & { text: string }; check: (actions: SuperRouteAction[]) => boolean }
const same = (a: SuperRouteAction[]) => a.length === 1 && a[0]?.kind === "continue" && a[0].ticketId === "T17"
const newRef = (a: SuperRouteAction[]) => a.length === 1 && a[0]?.kind === "create" && a[0].ticketId === "T17"
const original = "Create a file named result.txt in this workspace with only the word PASSED."
const resultTicket = { id: "T-file", title: "创建 result.txt", scope: "在 A 创建 result.txt，文件内容恰好为 PASSED，不含其他内容。仅修改该文件。", sessionId: "file-worker", summary: "已创建 result.txt，只含 PASSED。" }
const refinement = { text: "接着改刚才的 result.txt，保留原第一行，并在第二行写 NEXT。", focusTicketId: resultTicket.id,
  tickets: [resultTicket], recent: [{role: "user" as const, text: original, ticketId:resultTicket.id}, {role: "assistant" as const, text: "已创建 result.txt，只含 PASSED。", ticketId:resultTicket.id}] }
const cases: Case[] = [
  { name:"R9 revise acceptance on same artifact",ctx:refinement,check:a=>a.length===1 && a[0]?.kind==="continue" && a[0].ticketId==="T-file" && !!a[0].acceptanceUpdate?.includes("NEXT") },

  { name: "R1 quoted selection", ctx: { text: "选第二种", quote:{ticketId:"T17", text:lastQuestion.text}, recent:[lastQuestion] }, check: same },
  { name: "R2 unquoted foreground", ctx:{text:"2", recent:[lastQuestion,{role:"worker",ticketId:"T23",text:"后台测量完成"}], pendingQuestion:{ticketId:"T17",optionDisposition:"continue",options}},check:same },
  { name:"R3 ambiguous stop", ctx:{text:"慢的那个先停一下"},check:a=>a.length===1 && a[0]?.kind==="clarify" },
  { name:"R4 separate deliverable", ctx:{text:"另外把这项诊断写成一份客服 FAQ 文件。", quote:{ticketId:"T17",text:"登录慢来自重复取令牌。"}},check:newRef },
  { name:"R5 broader authority", ctx:{text:"按第二种改",tickets:[diagnose], quote:{ticketId:"T17", text:lastQuestion.text}},check:newRef },
  { name:"R6 rediscover old evidence",ctx:{text:"上次苹果公证用的是哪个证书？",tickets:[...base.tickets,...old]},check:a=>a.length===1 && a[0]?.kind==="answer" && a[0].text.includes(cert) },
  { name:"R7 casual acknowledgement",ctx:{text:"好的",recent:[lastQuestion,{role:"user",text:"先歇会儿，聊聊天"},{role:"assistant",text:"好，今天过得怎么样？"},{role:"user",text:"晚饭想吃清淡的"},{role:"assistant",text:"那可以做一碗蔬菜汤。"}]},check:a=>a.length===1 && a[0]?.kind==="answer" },
  { name:"R8 independent work",ctx:{text:"分开做两个独立交付。请生成贡献者入门指南文件；另外写一份独立的发布检查清单文件。"},check:a=>a.filter(item=>item.kind==="create").length===2 },
  { name:"C1 cross-project change",ctx:{workspaceId:null,text:"按第二种改，先别提交",recent:[{role:"user",text:"看一下 A 项目登录加速的选项"},{role:"assistant",text:"A 有两种做法：第一种合并请求，第二种推迟令牌获取。"}]},check:a=>a[0]?.kind==="handoff"&&a[0].workspaceId==="A"&&a[0].prompt==="按第二种改，先别提交"&&a[0].context.includes("令牌") },
  { name:"C2 cross-project read",ctx:{text:"只查一下 B 项目的 README.md，告诉我里面的代号。"},check:a=>a.length===1&&a[0]?.kind==="answer"&&a[0].text.includes("ORCHID") },
]
let failed=0
const filters = process.argv.slice(3)
const pending = cases.filter(entry => !filters.length || filters.includes(entry.name.split(" ")[0]!))
if (!pending.length) throw new Error("No matching replay cases")
async function run() {
  for (let entry = pending.shift(); entry; entry = pending.shift()) {
    const start = performance.now()
    try {
      const ctx={...base,...entry.ctx}
      const {actions}=await routeSuperMessage(ctx,{evidence:async req=>{
        if(req.kind==="ticket" && req.ticketId==="sign") return JSON.stringify({id:"sign",summary:`Notarization log records certificate: ${cert}.`})
        if(req.kind==="read" && req.workspaceId==="B" && req.path==="README.md") return JSON.stringify({path:"README.md",firstLine:1,text:"Project codename: ORCHID"})
        if(req.kind==="list" || req.kind==="search") return JSON.stringify({entries:["README.md"]})
        throw new Error("No synthetic evidence for that request")
      }})
      assert.ok(entry.check(actions), JSON.stringify(actions))
      console.log(`PASS ${entry.name} (${Math.round(performance.now()-start)} ms): ${actions.map(a=>a.kind).join(",")}`)
    } catch(error){failed++;console.error(`FAIL ${entry.name}: ${(error as Error).message}`)}
  }
}
await Promise.all([run(),run(),run()])
if(failed) process.exitCode=1
