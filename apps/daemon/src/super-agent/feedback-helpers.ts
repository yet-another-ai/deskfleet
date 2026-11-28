import { createHash } from "node:crypto"
import { detectFeedbackLanguage as detectLanguage } from "@deskfleet/protocol/super-agent-feedback"
import type { SuperEvidenceRequest } from "./evidence.ts"
export * from "@deskfleet/protocol/super-agent-feedback"

export function feedbackDedupeHash(parts: readonly (string | number | undefined)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16)
}

/**
 * Host fallback opening confirmation for substantive evidence-gathering tasks
 * when the coordinator omits `publicFeedback.ack` before executing slow evidence reads.
 * Returns `undefined` for short/simple Q&A lookups so direct answers stay unpadded.
 */
export function buildEvidenceFallbackAck(
  userText: string,
  requests: readonly SuperEvidenceRequest[],
  context: {
    tickets?: readonly { id: string; title: string }[]
    workspaces?: readonly { id: string; name: string }[]
    pass?: number
  } = {},
): string | undefined {
  const cleanUser = userText.replace(/\s+/gu, " ").trim()
  if (!cleanUser || !requests.length) return undefined
  const isSubstantive = requests.length >= 2
    || (context.pass ?? 0) >= 1
    || /(?:报告|方案|总结|清单|对比|排查|复盘|分析|评估|梳理|核对|验收|检查并|整理|汇总|兼容性|差异|原因|根因|report|summary|audit|analy(?:sis|ze)|compar(?:e|ison)|plan|checklist|review|investigat(?:e|ion)|compatibility|root cause|diagnos|レポート|まとめ|分析|比較|確認して|報告書)/iu.test(cleanUser)
  if (!isSubstantive) return undefined
  const lang = detectLanguage(cleanUser)
  const labels: string[] = []
  const seen = new Set<string>()
  const pushLabel = (label: string | undefined) => {
    const clean = label?.replace(/\s+/gu, " ").trim().slice(0, 60)
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    labels.push(clean)
  }
  for (const req of requests) {
    if (req.kind === "ticket") {
      const title = context.tickets?.find(t => t.id === req.ticketId)?.title
      pushLabel(title || (lang === "zh" ? "相关事项记录" : lang === "ja" ? "関連チケット" : "related ticket records"))
    } else if (req.kind === "read") {
      pushLabel(req.path?.split(/[\\/]/u).at(-1) || req.path)
    } else if (req.kind === "list") {
      pushLabel(req.path || context.workspaces?.find(w => w.id === req.workspaceId)?.name || ".")
    } else if (req.kind === "search") {
      pushLabel(context.workspaces?.find(w => w.id === req.workspaceId)?.name || (lang === "zh" ? "工作区内容" : lang === "ja" ? "ワークスペース" : "workspace files"))
    } else if (req.kind === "history") {
      pushLabel(lang === "zh" ? "相关会话历史" : lang === "ja" ? "関連セッション履歴" : "related session history")
    } else if (req.kind === "schedule" || req.kind === "scheduleRuns") {
      pushLabel(lang === "zh" ? "计划任务记录" : lang === "ja" ? "スケジュール記録" : "schedule records")
    }
  }
  const targetList = labels.slice(0, 2).map(item => lang === "en" ? `"${item}"` : `「${item}」`).join(lang === "zh" ? "、" : lang === "ja" ? "・" : " and ")
  const goal = cleanUser.length > 72 ? `${cleanUser.slice(0, 72)}…` : cleanUser
  if (lang === "zh") {
    return targetList
      ? `我会先核对 ${targetList}，再按你的要求整理回复（${goal}）。`
      : `我会先查阅相关资料，再按你的要求整理回复（${goal}）。`
  }
  if (lang === "ja") {
    return targetList
      ? `まず ${targetList} を確認し、ご依頼の内容（${goal}）をまとめてお返しします。`
      : `まず関連資料を確認し、ご依頼の内容（${goal}）をまとめてお返しします。`
  }
  return targetList
    ? `I will inspect ${targetList} first and reply with the requested result (${goal}).`
    : `I will inspect the relevant context first and reply with the requested result (${goal}).`
}

/** Safe, bounded user-facing label for a read-only coordinator evidence lookup. */
export function describeEvidenceActivity(request: SuperEvidenceRequest, userText: string): string {
  const lang = detectLanguage(userText)
  switch (request.kind) {
    case "read": {
      const target = request.path?.split(/[\\/]/u).at(-1) || "file"
      return lang === "zh" ? `查阅文件 ${target}` : lang === "ja" ? `ファイル ${target} を確認` : `Reading ${target}`
    }
    case "list": {
      const target = request.path || "."
      return lang === "zh" ? `查看目录 ${target}` : lang === "ja" ? `ディレクトリ ${target} を確認` : `Listing ${target}`
    }
    case "search":
      return lang === "zh" ? "检索工作区内容" : lang === "ja" ? "ワークスペース内を検索" : "Searching workspace"
    case "ticket":
      return lang === "zh" ? "核对已有事项记录" : lang === "ja" ? "既存チケットの記録を確認" : "Checking existing ticket details"
    case "history":
      return lang === "zh" ? "查阅相关会话历史" : lang === "ja" ? "関連セッション履歴を確認" : "Reviewing related session history"
    case "schedule":
      return lang === "zh" ? "查看计划任务配置" : lang === "ja" ? "スケジュール設定を確認" : "Checking schedule configuration"
    case "scheduleRuns":
      return lang === "zh" ? "查看计划运行记录" : lang === "ja" ? "スケジュール実行履歴を確認" : "Checking schedule run history"
  }
}
