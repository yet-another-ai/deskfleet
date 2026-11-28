import { createHash } from "node:crypto"
import type { FollowUpDeliveryPolicy, FollowUpRuleMode } from "@deskfleet/protocol/super-agent-follow-up"
import type { CrossWorkerMatch, TurnOutputSource } from "./follow-up-evidence.ts"
import { effectiveCoordinatorProfile } from "./profiles.ts"
import type { SuperCoordinatorOptions } from "@deskfleet/protocol/super-agent"
import type { SuperDecisionModel } from "./router.ts"
import type { SuperStateStore } from "./state.ts"

export type TriageDecisionKind = "record_quietly" | "deliver_result" | "supplement_worker" | "create_ticket" | "ask_human"

export interface TriageDecision {
  kind: TriageDecisionKind
  summary: string
  /** Bounded execution details / output excerpt for this specific run, shown inside the expanded execution card. */
  detail?: string
  reason: string
  /** False when the notice informs the user that no formal report/final answer was produced (so run.delivered stays false). */
  reportDelivered?: boolean
  /** Context to deliver to a blocked Worker (only when kind === "supplement_worker"). */
  supplementText?: string
  /** Optional title/scope when escalating into a dedicated ticket. */
  ticketTitle?: string
  ticketScope?: string
  /** Concrete decision choices when kind === "ask_human". */
  options?: string[]
  recommendation?: string
  issueKey?: string
}

export interface TriageInput {
  userId: string
  workspaceId: string
  sourceKind: "schedule" | "session"
  sourceId: string
  sourceTitle: string
  runKey: string
  status: "completed" | "failed" | "interrupted" | "skipped" | "attention"
  deliveryPolicy: FollowUpDeliveryPolicy
  ruleMode: FollowUpRuleMode
  outputText: string
  error?: string
  lastSuccessAt?: string
  consecutiveSkips?: number
  repeatedErrorCount?: number
  issueKey?: string
  stoppedIssueKeys?: string[]
  crossWorkerMatches?: CrossWorkerMatch[]
  relatedSeparateRefs?: CrossWorkerMatch[]
  pendingQuestionText?: string
  hasPendingApproval?: boolean
  prStatusNote?: string
  /** True when the turn's journal transcript could not be read completely through terminal state. */
  evidenceIncomplete?: boolean
  /** True when the execution session has been confirmed deleted from the journal. */
  evidenceDeleted?: boolean
  /** True when the selected output exceeded the capture buffer and kept the concluding range. */
  outputTruncated?: boolean
  /** Provenance/purpose tag of the extracted turn output (distinguishes final_answer vs commentary/ack/milestone). */
  outputSource?: TurnOutputSource
}

export type TriageModel = (packet: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>

/** Compute a deterministic evidence version so the same finding triggers at most one proactive action. */
export function computeEvidenceVersion(parts: (string | number | undefined)[]): string {
  return createHash("sha256").update(parts.map(part => String(part ?? "")).join("\0")).digest("hex").slice(0, 24)
}

/**
 * Bound a delivery summary without dropping the concluding answer at the end.
 * When a long untagged output exceeds `maxChars`, preserve both the opening context and the
 * concluding tail with an explicit truncation notice pointing back to the original session.
 */
export function boundSummaryText(text: string, maxChars = 4000, suffix = ""): string {
  const full = text + suffix
  if (full.length <= maxChars) return full
  const marker = "\n\n... [output truncated; open the original execution session for full details] ...\n\n"
  const available = maxChars - suffix.length - marker.length
  if (available <= 200) {
    const keepTail = Math.max(0, maxChars - suffix.length)
    return text.slice(-keepTail) + suffix
  }
  const headChars = Math.min(1000, Math.floor(available * 0.3))
  const tailChars = available - headChars
  return `${text.slice(0, headChars).trimEnd()}${marker}${text.slice(-tailChars).trimStart()}${suffix}`
}

const EN_ISSUE_NOUN = "(?:changes?|commits?|issues?|risks?|findings?|errors?|failures?|failed|regressions?|warnings?|conflicts?|blockers?|exceptions?|problems?|bugs?|incidents?|anomalies?|alerts?|timeouts?|outages?)"
const EN_NEGATED_RE = new RegExp(
  `\\b(?:no|zero|without|neither|nor)\\s+(?:new\\s+|known\\s+|open\\s+|critical\\s+|blocking\\s+|apparent\\s+|remaining\\s+|significant\\s+|potential\\s+)?${EN_ISSUE_NOUN}(?:\\s*(?:,|\\bor\\b|\\band\\b|\\bnor\\b)\\s*(?:new\\s+|known\\s+|open\\s+|critical\\s+|potential\\s+)?${EN_ISSUE_NOUN})*(?:\\s+(?:found|detected|observed|reported|remaining|present|identified))?\\b`
  + `|\\b(?:0|zero)\\s+${EN_ISSUE_NOUN}\\b`
  + `|\\b${EN_ISSUE_NOUN}\\s*[:：]\\s*(?:0|none|n\\/a|nil|zero|no)\\b`
  + `|\\bfree\\s+of\\s+${EN_ISSUE_NOUN}(?:\\s*(?:,|\\bor\\b|\\band\\b)\\s*${EN_ISSUE_NOUN})*\\b`
  + `|\\bnot\\s+(?:broken|blocked|failing|failed|critical)\\b`
  + `|\\bno\\s+action\\s+(?:needed|required)\\b`,
  "giu",
)
const ZH_ISSUE_NOUN = "(?:新提交|变更|变化|问题|异常|风险|失败|报错|错误|回归|冲突|阻塞|警告|故障|隐患|告警|超时)"
const ZH_NEGATED_RE = new RegExp(
  `(?:无|没有|暂无|未发现|未见|未出现|不存在|零|0\\s*个?)(?:任何|新的?|明显|重大|潜在|已知)?${ZH_ISSUE_NOUN}(?:(?:或|与|和|、|及)(?:任何|新的?|潜在)?${ZH_ISSUE_NOUN})*`
  + `|${ZH_ISSUE_NOUN}\\s*[:：]\\s*(?:无|没有|暂无|未发现|0|零|none)`
  + `|(?:无|没有|未)(?:需要|需)(?:确认|决定|人工介入|处理|操作|关注)`,
  "giu",
)
const JA_NEGATED_RE = /(?:異常|リスク|エラー|失敗|問題|警告|競合)(?:なし|はありません|は見つかりませんでした|0件)/gu

/** Explicit statements that a job/backup/check never executed: an exception even without "error"/"fail" vocabulary. */
const NOT_EXECUTED_RE = /(?:\b(?:did\s*(?:not|n['’]t)|does\s*(?:not|n['’]t)|has\s*(?:not|n['’]t)|have\s*(?:not|n['’]t)|was\s*(?:not|n['’]t)|were\s*(?:not|n['’]t)|never|not\s+yet)\s+(?:been\s+)?(?:run|ran|execute[ds]?|executing|start(?:ed|s)?|complete[ds]?|finish(?:ed|es)?|trigger(?:ed|s)?|happen(?:ed|s)?|perform(?:ed|s)?|kick(?:ed)?\s+off)\b|\bnot\s+(?:executed|performed|triggered|started|completed)\b|未执行|未运行|没有执行|没有运行|没执行|没运行|未启动|未触发|未完成|没有完成|没完成|未能)/iu
const POSITIVE_ANOMALY_RE = /(?:error|fail|failed|failure|risk|regression|warning|broken|conflict|critical|blocked|blocker|exception|bug|incident|outage|timeout|timed\s+out|alert|urgent|immediate(?:ly)?|crash(?:ed)?|unhealthy|degraded|needs?\s+attention|\bhttp\s*[45]\d\d\b|\b(?:429|50[0234])\b|返回\s*[45]\d\d|异常|风险|失败|报错|错误|回归|冲突|阻塞|警告|故障|隐患|告警|超时|宕机|崩溃|中断|不可用|积压|降级|立即处理|紧急|需确认|需要决定|需要人工|待确认|待决定|需立即)/iu
const ACTION_OR_CONTRAST_RE = /(?:\b(?:but|however|though|although|yet|except|otherwise|instead|whereas|unfortunately|caveat|only|partial(?:ly)?|below|less\s+than|fewer\s+than|please|need\s+to|needs?\s+to|should|must|recommend|investigate|fix|patch|pause|halt|rollback|escalate|confirm|approve|follow\s+up|action\s+required|detected|found|discovered|observed|triggered|occurred|happened|increased|decreased|dropped|spiked|elevated|slow(?:er|ed)?|expir(?:ing|ed|y)|backlog|stale|drift|mismatch|missing|changed|modified)\b|但是|但|不过|然而|唯独|除了|却|可惜|需要注意的是|仅|只|只有|仅有|部分|少数|不足|低于|少于|请|需要|需|建议|应当|必须|排查|修复|暂停|回滚|扩容|切换|确认|审批|关注|跟进|处理|联系|重启|升级|发现|出现|存在|发生|触发|导致|引起|新增|变化|变更|变慢|升高|下降|飙升|激增|抖动|波动|过期|即将过期|接近上限|超标|超限|缺失|不一致|滞后|失败率|延迟过高|怪)/iu
const CLEAN_POSITIVE_RE = /(?:nothing\s+to\s+report|all\s+clear|all\s+(?:checks\s+|tests\s+)?passed|everything\s+(?:is\s+|looks\s+)?(?:clean|healthy|ok|normal|green)|looks?\s+clean|status\s*[:：]\s*(?:clean|ok|pass|passed|green|healthy|正常)|一切正常|全部通过|均通过|均正常|运行正常|正常完成|状态\s*[:：]\s*(?:正常|通过|无异常))/giu
const CLEAN_SIGNAL_MATCH_RE = new RegExp(
  `${EN_NEGATED_RE.source}|${ZH_NEGATED_RE.source}|${JA_NEGATED_RE.source}|${CLEAN_POSITIVE_RE.source}`,
  "giu",
)
const BENIGN_FRAMING_RE = /(?:昨日|今日|今天|昨天|本次|每日|定时|任务|巡检|检查|审计|排查|提交|代码|已巡检|已检查|已完成|完成|结束|结果|总结|汇报|报告|状态|结论|均已|均|都|已|巡回|確認|完了|本日|\b(?:daily|nightly|weekly|scheduled|patrol|check|checks|audit|scan|review|summary|report|status|result|results|completed|finished|complete|done|checked|reviewed|inspected|yesterday|today|latest|recent|commits?|changes?|run|task|and|or|with|for|of|in|on|the|is|are|was|were|all|still)\b|\b\d{4}-\d{2}-\d{2}(?:[tT ]\d{2}:\d{2}(?::\d{2})?Z?)?\b)/giu
const CLEAN_PUNCT_SPACE_RE = /[\s,，、.:：\-—–_()（）[\]【】/·•*`'"“”‘’]+/gu
const STANDALONE_NUMERIC_CLAIM_RE = /(?:^|[\s（(，,、:：/])(?:\d+(?:\.\d+)?\s*(?:%|‰|ms|s|秒|笔|条|个|次|项|台|例|件|人|MB|GB|KB)|\d+\s*\/\s*\d+|\d+(?:\.\d+)?(?=\s*(?:of|out\s+of|succeeded|failed|passed|total|笔|条|个|次|项)|$|[\s）)，,、]))/iu
const EN_SUBJECT_ITEM_RE = /^[A-Za-z][A-Za-z0-9._\-\/ ]{0,28}$/u

function stripCleanAndFraming(text: string): { hadClean: boolean; residue: string } {
  let residue = text
  let hadClean = false
  for (const re of [EN_NEGATED_RE, ZH_NEGATED_RE, JA_NEGATED_RE, CLEAN_POSITIVE_RE]) {
    re.lastIndex = 0
    const next = residue.replace(re, " ")
    if (next !== residue) hadClean = true
    residue = next
  }
  const cleaned = residue.replace(BENIGN_FRAMING_RE, " ").replace(CLEAN_PUNCT_SPACE_RE, "")
  return { hadClean, residue: cleaned }
}

/**
 * Validate a subject prefix appearing BEFORE the first clean predicate in a clause
 * (e.g. "支付接口 A、B、C " or "支付和库存" before "全部通过，无异常", or "Payment API A, B, C "
 * before "all checks passed").
 *
 * Strictly rejects:
 * - Chinese clause commas (`，`) which introduce an independent preceding statement (e.g.
 *   "支付 100 笔仅成功 2 笔，库存检查" before "全部通过")
 * - Standalone numeric/metric claims or counts (e.g. "100 笔", "2 笔", "2/100", "2%", "99.9%")
 *   so quantitative findings are handed to the triage model or conservative alert path
 * - English comma clauses that aren't concise pure identifier/service names.
 * - Sentence terminators or negated predicates, which make the prefix an independent statement.
 */
function isBenignCheckedSubjectPrefix(prefix: string): boolean {
  const trimmed = prefix.trim()
  if (!trimmed) return true
  if (trimmed.length > 60) return false
  // Strip benign framing dates/headers first so dates like "2026-11-24" don't look like numeric claims.
  const withoutFraming = trimmed.replace(BENIGN_FRAMING_RE, " ").trim()
  if (!withoutFraming) return true
  // A Chinese comma `，` before the clean verdict indicates an independent preceding clause (NOT a subject list!).
  if (withoutFraming.includes("，")) return false
  // A sentence terminator or a negated predicate means the prefix is its own statement, not a subject label
  // (e.g. "Backups did not run. Inventory:" before "all checks passed").
  if (/[.。!！?？](?:\s|$)/u.test(trimmed)) return false
  if (/\b(?:not|never|no|cannot|unable|(?:did|does|do|is|was|were|are|has|have|had|wo|ca)n['’]t)\b|未|没|不|非|无法/iu.test(trimmed)) return false
  // Independent numeric claims / counts / metrics must NOT be treated as a bare subject label.
  if (STANDALONE_NUMERIC_CLAIM_RE.test(withoutFraming)) return false
  // Parenthetical notes are only allowed if they contain no standalone numeric claims.
  if (/[（(][^）)]*\d[^）)]*[）)]/u.test(withoutFraming)) return false
  // English comma-separated subject lists (e.g. "Payment API A, B, C") must be short pure identifier tokens.
  if (withoutFraming.includes(",")) {
    const parts = withoutFraming.split(",").map(p => p.trim()).filter(Boolean)
    if (parts.length > 8) return false
    return parts.every(part => EN_SUBJECT_ITEM_RE.test(part))
  }
  return withoutFraming.length <= 40
}

/**
 * Determine whether an ENTIRE completed run's text is provably a clean/no-risk report that
 * should remain quiet under `exceptions_only`.
 *
 * Fail-closed rule:
 * 1. Positive anomaly, contrastive pivot, or action/escalation signals anywhere outside negated
 *    phrases always return `false`.
 * 2. Every sentence/clause must either be pure benign framing OR contain an explicit clean verdict
 *    whose trailing text contains only additional clean verdicts/framing and whose leading prefix
 *    (if any) is at most a concise checked-subject/service/metric label.
 */
export function looksCleanNoRisk(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true

  // 1. Strip negated clean phrases first and fail fast on any anomaly, contrast, or action signal.
  const withoutNegated = trimmed
    .replace(EN_NEGATED_RE, " ")
    .replace(ZH_NEGATED_RE, " ")
    .replace(JA_NEGATED_RE, " ")
  if (POSITIVE_ANOMALY_RE.test(withoutNegated) || ACTION_OR_CONTRAST_RE.test(withoutNegated) || NOT_EXECUTED_RE.test(withoutNegated)) {
    return false
  }

  // 2. Verify EVERY clause in the report is provably clean or pure framing.
  // English full stops end an independent statement when followed by whitespace or the end of text;
  // dots inside decimals (99.5%) and identifiers (api.v2) are not boundaries. Same-line and
  // line-separated statements must therefore be judged identically.
  const clauses = trimmed.split(/(?:[。！？!?\n;；]|\.(?=\s|$))+/u).map(part => part.trim()).filter(Boolean)
  if (!clauses.length) return true

  let hadCleanSignal = false
  for (const clause of clauses) {
    const whole = stripCleanAndFraming(clause)
    if (whole.hadClean) hadCleanSignal = true
    if (whole.residue.length === 0) continue

    // If residue remains, this clause MUST itself carry an explicit clean verdict, with only
    // a concise checked-subject label before the first clean verdict and ZERO unexplained text after it.
    CLEAN_SIGNAL_MATCH_RE.lastIndex = 0
    const firstMatch = CLEAN_SIGNAL_MATCH_RE.exec(clause)
    if (!firstMatch) return false
    const prefix = clause.slice(0, firstMatch.index)
    const fromFirstClean = clause.slice(firstMatch.index)
    const tailCheck = stripCleanAndFraming(fromFirstClean)
    if (!tailCheck.hadClean || tailCheck.residue.length > 0) {
      return false
    }
    if (!isBenignCheckedSubjectPrefix(prefix)) {
      return false
    }
    hadCleanSignal = true
  }
  return hadCleanSignal
}

const CJK_RE = /[\u4e00-\u9fff]/u
const BARE_STATUS_LABEL_RE = /^(?:(?:completed|done|success|succeeded|ok|passed|failed|failure|error|interrupted|cancelled|skipped|running|claimed|attention|restricted|已完成|完成|成功|正常|通过|失败|执行失败|已中断|中断|已跳过|跳过|运行中|需要处理|受限)[\s.。!！·\-—:：]*)+$/iu
const MARKDOWN_TABLE_SEP_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/mu
const CONCLUSION_CUE_RE = /(?:最终结论|结论|总结|建议|结果|发现|告警|风险|异常|超标|超时|回归|失败|通过|正常|无异常|无需处理|\b(?:conclusion|summary|verdict|recommend(?:ed|ation)?|result|found|finding|alert|risk|anomaly|failed|passed|healthy|clean)\b)/iu
const UNFINISHED_CUE_RE = /(?:未完成|尚未|暂缓|待处理|待跟进|待确认|未执行|未运行|未提交|阻塞|跳过|未通过|部分完成|仅完成|冲突|\b(?:unfinished|incomplete|not\s+(?:completed|finished|executed|run|done|merged|installed)|pending|deferred|blocked|remaining|skipped|conflict|partial(?:ly)?)\b)/iu
const ACTION_CUE_RE = /(?:请|需要(?:你|人工|用户)?(?:确认|决定|审批|处理|排查|修复|操作|介入|跟进|重启|重跑|检查)|建议|立即处理|需确认|待确认|待决定|先修复|先合入|\b(?:please|action\s+required|needs?\s+(?:your\s+)?(?:approval|confirmation|decision|attention|review|action|input)|recommend|should|must|investigate|fix|confirm|approve|rerun|escalate)\b)/iu

function isCjkPrimary(input: Pick<TriageInput, "sourceTitle" | "outputText" | "error">): boolean {
  return CJK_RE.test(`${input.outputText}\n${input.sourceTitle}\n${input.error ?? ""}`)
}

function stripMarkdownForSummary(raw: string): string {
  const lines = raw.replace(/\r\n?/gu, "\n").split("\n")
  const kept: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    // Drop raw markdown table rows so summaries never paste markdown tables.
    if (/^\s*\|.*\|\s*$/u.test(line)) continue
    let cleaned = line
      .replace(/^\s*#{1,6}\s+/u, "")
      .replace(/^\s*[-*+]\s+/u, "")
      .replace(/^\s*\d+\.\s+/u, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
      .replace(/\*\*([^*]+)\*\*/gu, "$1")
      .replace(/__([^_]+)__/gu, "$1")
      .replace(/[`~]+/gu, "")
      .replace(/\s+/gu, " ")
      .trim()
    if (!cleaned) continue
    // Skip bare separator or pure link-label breadcrumb lines.
    if (/^[·•\-—–|/\\.,:;!?()[\]\s]+$/u.test(cleaned)) continue
    kept.push(cleaned)
  }
  return kept.join("\n")
}

function extractUniqueSentences(text: string): string[] {
  const cleaned = stripMarkdownForSummary(text)
  if (!cleaned) return []
  const rawParts = cleaned
    .split(/(?:\n+|(?<=[。！？!?])|(?<=\.)\s+)/u)
    .map(part => part.trim())
    .filter(part => part.length >= 2)
  const seen = new Set<string>()
  const unique: string[] = []
  for (const part of rawParts) {
    const key = part.toLocaleLowerCase().replace(/\s+/gu, " ")
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(part)
  }
  return unique
}

function clipClause(text: string, maxChars: number, preserveTail = false): string {
  const normalized = text.replace(/\s+/gu, " ").trim()
  if (normalized.length <= maxChars) return normalized
  if (preserveTail && maxChars >= 80) {
    const headLen = Math.min(60, Math.floor(maxChars * 0.3))
    const tailLen = maxChars - headLen - 3
    return `${normalized.slice(0, headLen).trimEnd()} … ${normalized.slice(-tailLen).trimStart()}`
  }
  return `${normalized.slice(0, Math.max(20, maxChars - 1)).trimEnd()}…`
}

function needsDistillation(text: string, input: Pick<TriageInput, "outputTruncated">): boolean {
  if (input.outputTruncated) return true
  if (text.length > 240) return true
  if (MARKDOWN_TABLE_SEP_RE.test(text)) return true
  if (/^\s*```/mu.test(text)) return true
  if (/^\s*#{1,6}\s+/mu.test(text)) return true
  if (/\n\s*\n/u.test(text)) return true
  if (text.split("\n").filter(line => line.trim()).length > 2) return true
  return false
}

/** Build bounded raw execution detail for the expandable execution card (never pasted into collapsed SA summary). */
export function buildRunExecutionDetail(input: Pick<TriageInput, "outputText" | "error" | "prStatusNote" | "evidenceDeleted">): string | undefined {
  if (input.evidenceDeleted) return undefined
  const parts: string[] = []
  const output = input.outputText.trim()
  if (output) parts.push(output)
  const error = input.error?.trim()
  if (error && (!output || !output.includes(error))) {
    parts.push(CJK_RE.test(error) ? `错误：${error}` : `Error: ${error}`)
  }
  if (input.prStatusNote?.trim()) {
    parts.push(`PR status: ${input.prStatusNote.trim()}`)
  }
  if (!parts.length) return undefined
  return boundSummaryText(parts.join("\n\n"), 6000)
}

/**
 * Deterministically distill a run's actual content into a concise SA summary covering:
 * conclusion, unfinished/blocked items (when present), and whether user action is needed.
 * Short single-line factual conclusions stay crisp and unmodified when no model is configured.
 */
export function summarizeCompletedRunOutput(input: TriageInput): string {
  const trimmed = input.outputText.trim()
  const prSuffix = input.prStatusNote ? `\n\nPR status: ${input.prStatusNote}` : ""
  if (!trimmed) {
    return isCjkPrimary(input)
      ? `「${input.sourceTitle}」已结束，但未产出正文结论（结果未确认）；请打开执行会话核对是否真正完成。`
      : `Run completed with no text output.`
  }
  if (!needsDistillation(trimmed, input)) {
    return `${trimmed}${prSuffix}`
  }

  const zh = isCjkPrimary(input)
  const sentences = extractUniqueSentences(trimmed)
  if (!sentences.length) {
    return zh
      ? `「${input.sourceTitle}」已结束，但仅包含非正文内容，未提取到明确结论；请打开执行会话核对。`
      : `"${input.sourceTitle}" finished, but no concise conclusion text was extracted; open the execution session to inspect.`
  }

  // Pick up to 2 highest-signal conclusion sentences (explicit conclusion/verdict/finding preferred,
  // otherwise opening + concluding sentences so the final verdict at the tail is never lost).
  const scored = sentences.map((sentence, index) => {
    let score = 0
    if (CONCLUSION_CUE_RE.test(sentence)) score += 3
    if (index === sentences.length - 1) score += 2
    if (index === 0) score += 1
    if (sentence.length > 260) score -= 1
    return { sentence, index, score }
  })
  const topConclusion = scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)
    .map(item => clipClause(item.sentence, 200, item.index === sentences.length - 1))
  const conclusionText = topConclusion.join(zh ? " " : " ")

  const unfinished = sentences
    .filter(s => UNFINISHED_CUE_RE.test(s) && !topConclusion.some(c => c.includes(s.slice(0, 24)) || s.includes(c.slice(0, 24))))
    .slice(0, 2)
    .map(s => clipClause(s, 140))

  const hasAction = !looksCleanNoRisk(trimmed) && (
    ACTION_CUE_RE.test(trimmed) || POSITIVE_ANOMALY_RE.test(trimmed) || NOT_EXECUTED_RE.test(trimmed)
  )
  const actionCandidates = hasAction
    ? sentences.filter(s => ACTION_CUE_RE.test(s) && !topConclusion.some(c => c.includes(s.slice(0, 24)))).slice(0, 1)
    : []

  const lines: string[] = []
  if (zh) {
    lines.push(`**${input.sourceTitle}** 结论：${conclusionText}`)
    if (unfinished.length) lines.push(`- 未完成 / 待处理：${unfinished.join("；")}`)
    if (hasAction) {
      lines.push(actionCandidates.length
        ? `- 需要你操作：${clipClause(actionCandidates[0]!, 160)}`
        : `- 需要你操作：发现需要确认或处理的事项，请按上述结论决定后续操作。`)
    } else {
      lines.push(`- 是否需要操作：暂无需操作。`)
    }
  } else {
    lines.push(`**${input.sourceTitle}** conclusion: ${conclusionText}`)
    if (unfinished.length) lines.push(`- Incomplete / remaining: ${unfinished.join("; ")}`)
    if (hasAction) {
      lines.push(actionCandidates.length
        ? `- Action needed: ${clipClause(actionCandidates[0]!, 160)}`
        : `- Action needed: Review the findings above and decide on the next step.`)
    } else {
      lines.push(`- Action needed: None required.`)
    }
  }
  if (input.prStatusNote) lines.push(`- PR: ${input.prStatusNote}`)
  return lines.join("\n").slice(0, 900)
}

function buildFailureSummary(input: TriageInput): string {
  const errText = input.error?.trim() || (input.status === "interrupted" ? "Execution was interrupted before confirmation." : "Execution failed.")
  const authHint = /delegation|unauthorized|sign.?in|auth|member/iu.test(errText)
    ? " Re-check sign-in or team authorization and rerun."
    : ""
  const lastSuccess = input.lastSuccessAt ? ` Last successful run: ${input.lastSuccessAt}.` : ""
  const repeatNote = (input.repeatedErrorCount ?? 1) > 1 ? ` (Occurred ${input.repeatedErrorCount} times)` : ""
  const partialSentences = input.outputText.trim() ? extractUniqueSentences(input.outputText) : []
  const partialHighlight = partialSentences.length && !errText.includes(partialSentences[0]!)
    ? clipClause(partialSentences.at(-1)!, 160)
    : undefined
  const partialNote = partialHighlight ? ` Partial progress before failure: ${partialHighlight}.` : ""
  const actionNote = authHint || " Action needed: inspect the execution session and retry or fix the failure."
  return `"${input.sourceTitle}" did not complete (${input.status}): ${errText}${repeatNote}.${partialNote}${lastSuccess}${actionNote}`
}

/** Reject bare status labels, verbatim raw report pastes, raw truncation notices, or misleading success claims on failures. */
export function isLowQualityModelSummary(summary: string, input: TriageInput): boolean {
  const trimmed = summary.trim()
  if (!trimmed) return true
  if (BARE_STATUS_LABEL_RE.test(trimmed)) return true
  if (/\.\.\.\s*\[output truncated/iu.test(trimmed)) return true
  if (MARKDOWN_TABLE_SEP_RE.test(trimmed)) return true
  const rawOutput = input.outputText.trim()
  if (rawOutput.length > 420) {
    const normSummary = trimmed.replace(/\s+/gu, " ")
    const normRaw = rawOutput.replace(/\s+/gu, " ")
    if (normSummary === normRaw || (normSummary.length > 650 && normRaw.startsWith(normSummary.slice(0, 300)))) {
      return true
    }
  }
  if ((input.status === "failed" || input.status === "interrupted") && looksCleanNoRisk(trimmed)) {
    return true
  }
  return false
}

function parseModelDecision(raw: unknown, fallbackSummary: string, input?: TriageInput): TriageDecision | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const kind = obj.kind
  if (kind !== "record_quietly" && kind !== "deliver_result" && kind !== "supplement_worker" && kind !== "create_ticket" && kind !== "ask_human") {
    return undefined
  }
  const rawSummary = typeof obj.summary === "string" && obj.summary.trim() ? obj.summary.trim().slice(0, 4000) : ""
  const summary = rawSummary && (!input || !isLowQualityModelSummary(rawSummary, input)) ? rawSummary : fallbackSummary
  const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim().slice(0, 1000) : "Coordinator triage"
  const options = Array.isArray(obj.options)
    ? obj.options.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, 6)
    : undefined
  return {
    kind,
    summary,
    reason,
    ...(typeof obj.supplementText === "string" && obj.supplementText.trim() ? { supplementText: obj.supplementText.trim().slice(0, 4000) } : {}),
    ...(typeof obj.ticketTitle === "string" && obj.ticketTitle.trim() ? { ticketTitle: obj.ticketTitle.trim().slice(0, 200) } : {}),
    ...(typeof obj.ticketScope === "string" && obj.ticketScope.trim() ? { ticketScope: obj.ticketScope.trim().slice(0, 2000) } : {}),
    ...(options?.length ? { options } : {}),
    ...(typeof obj.recommendation === "string" && obj.recommendation.trim() ? { recommendation: obj.recommendation.trim().slice(0, 1000) } : {}),
    ...(typeof obj.issueKey === "string" && obj.issueKey.trim() ? { issueKey: obj.issueKey.trim().slice(0, 200) } : {}),
  }
}

/**
 * Deterministic-first triage with optional bounded coordinator model escalation.
 * Hard invariants enforced in code:
 * - Never reports a failed/interrupted/unverified run as "no risk".
 * - Respects user-stopped issue keys.
 * - "every_run" always delivers schedules (including zero-change runs).
 * - "exceptions_only" records clean runs quietly without chat spam.
 * - Never grants new permissions or auto-approves native permission prompts.
 */
export async function triageFollowUpEvent(
  input: TriageInput,
  options: { model?: TriageModel; signal?: AbortSignal } = {},
): Promise<TriageDecision> {
  const detail = buildRunExecutionDetail(input)

  // 1. User previously stopped/dismissed this exact issue -> keep quiet unless it's an explicit every_run schedule report.
  if (input.issueKey && input.stoppedIssueKeys?.includes(input.issueKey) && !(input.sourceKind === "schedule" && input.deliveryPolicy === "every_run")) {
    return {
      kind: "record_quietly",
      summary: input.error || summarizeCompletedRunOutput(input) || "Repeated signal suppressed after user stop.",
      ...(detail ? { detail } : {}),
      reason: "User explicitly stopped this issue",
      issueKey: input.issueKey,
    }
  }

  // 2. Native tool approval requests ALWAYS belong to the user (never auto-approved by triage).
  if (input.hasPendingApproval) {
    return {
      kind: "ask_human",
      summary: input.pendingQuestionText || `Execution session "${input.sourceTitle}" is waiting for permission approval.`,
      ...(detail ? { detail } : {}),
      reason: "Explicit permission request requires human approval",
      issueKey: input.issueKey,
    }
  }

  // 3. Consecutive overlap skips: single skip is quiet history; repeated skips causing missed delivery merge into one issue.
  if (input.status === "skipped") {
    if ((input.consecutiveSkips ?? 1) >= 2) {
      return {
        kind: "deliver_result",
        summary: `Scheduled task "${input.sourceTitle}" was skipped ${input.consecutiveSkips} consecutive times because a previous run is still active.${input.lastSuccessAt ? ` Last successful run: ${input.lastSuccessAt}.` : ""}`,
        ...(detail ? { detail } : {}),
        reason: "Consecutive overlap skips caused missed scheduled delivery",
        issueKey: input.issueKey ?? `skip:${input.workspaceId}:${input.sourceId}`,
      }
    }
    return {
      kind: "record_quietly",
      summary: input.error || "Skipped overlapping scheduled run.",
      ...(detail ? { detail } : {}),
      reason: "Single overlap skip recorded in history",
      issueKey: input.issueKey,
    }
  }

  // 4. Execution failures / interruptions: NEVER report as "no risk" or silence to record_quietly.
  if (input.status === "failed" || input.status === "interrupted") {
    const fallbackFailure = buildFailureSummary(input)
    if (options.model) {
      try {
        const raw = await options.model({
          kind: "follow_up_triage",
          sourceKind: input.sourceKind,
          sourceTitle: input.sourceTitle,
          status: input.status,
          deliveryPolicy: input.deliveryPolicy,
          error: input.error,
          outputText: boundSummaryText(input.outputText.trim(), 6000),
          lastSuccessAt: input.lastSuccessAt,
          repeatedErrorCount: input.repeatedErrorCount,
          prStatusNote: input.prStatusNote,
        }, options.signal)
        const parsed = parseModelDecision(raw, fallbackFailure, input)
        if (parsed) {
          const safeKind = parsed.kind === "ask_human" || parsed.kind === "create_ticket" ? parsed.kind : "deliver_result"
          return {
            ...parsed,
            kind: safeKind,
            ...(detail ? { detail } : {}),
            issueKey: parsed.issueKey ?? input.issueKey,
          }
        }
      } catch {
        // Model unavailable: fall back to deterministic failure summary below.
      }
    }
    return {
      kind: "deliver_result",
      summary: fallbackFailure,
      ...(detail ? { detail } : {}),
      reason: "Incomplete or failed execution must surface clearly",
      issueKey: input.issueKey,
    }
  }

  // 5. Blocked Worker with a pending question: check verified cross-Worker evidence first!
  if (input.status === "attention" && input.pendingQuestionText) {
    if (input.crossWorkerMatches?.length) {
      const cited = input.crossWorkerMatches.map(match =>
        `From session "${match.title}" (${match.sessionId}, ${match.prRef.owner}/${match.prRef.repo}#${match.prRef.number}): ${match.summary.slice(0, 600)}`,
      ).join("\n")
      if (options.model) {
        try {
          const raw = await options.model({
            kind: "follow_up_triage",
            sourceKind: input.sourceKind,
            sourceTitle: input.sourceTitle,
            question: input.pendingQuestionText,
            verifiedCrossWorkerEvidence: input.crossWorkerMatches,
            relatedSeparateRefs: input.relatedSeparateRefs,
            prStatusNote: input.prStatusNote,
          }, options.signal)
          const parsed = parseModelDecision(raw, input.pendingQuestionText, input)
          if (parsed) return { ...parsed, ...(detail ? { detail } : {}) }
        } catch {
          // Graceful degradation: fall back to deterministic cross-worker handling below.
        }
      }
      // Deterministic safe supplementation when exact repo/PR + objective match exists and no product choice is asked.
      const needsProductDecision = /(?:product|design|prefer|choose|which\s+option|trade-?off|取舍|产品|希望按|选哪|还是按)/iu.test(input.pendingQuestionText)
      if (!needsProductDecision) {
        return {
          kind: "supplement_worker",
          summary: `Supplemented "${input.sourceTitle}" with verified context from ${input.crossWorkerMatches.map(m => `${m.prRef.owner}/${m.prRef.repo}#${m.prRef.number}`).join(", ")}.`,
          ...(detail ? { detail } : {}),
          supplementText: `Verified context from another Worker on the same PR and objective:\n${cited}`,
          reason: "Verified cross-Worker evidence answers the factual blocker",
          issueKey: input.issueKey,
        }
      }
      return {
        kind: "ask_human",
        summary: `${input.pendingQuestionText}\n\nVerified context:\n${cited}`,
        ...(detail ? { detail } : {}),
        reason: "Product or policy decision requires human choice",
        issueKey: input.issueKey,
      }
    }
    return {
      kind: "ask_human",
      summary: input.pendingQuestionText,
      ...(detail ? { detail } : {}),
      reason: "Worker asked a question requiring human input",
      issueKey: input.issueKey,
    }
  }

  // 5b. Sustained silent stall on a running ordinary Worker without a pending question or approval.
  if (input.status === "attention") {
    const stallDetail = input.error?.trim() || "No new progress events were recorded across consecutive periodic checks."
    return {
      kind: "ask_human",
      summary: `"${input.sourceTitle}" appears stalled: ${stallDetail}`,
      ...(detail ? { detail } : {}),
      reason: "Worker showed no progress across consecutive periodic checks",
      issueKey: input.issueKey ?? `stall:${input.workspaceId}:${input.sourceId}`,
      options: ["Open execution session to inspect", "Continue waiting", "Stop following this stall alert"],
    }
  }

  // 6. Completed runs / turns
  const trimmedOutput = input.outputText.trim()
  const prSuffix = input.prStatusNote ? `\n\nPR status: ${input.prStatusNote}` : ""

  if (input.evidenceDeleted) {
    const deletedSummary = `"${input.sourceTitle}" finished, but its execution session was deleted so the original output is no longer available.${prSuffix}`
    if (input.sourceKind === "session") {
      return {
        kind: "record_quietly",
        summary: deletedSummary.slice(0, 1000),
        reason: "Execution session was confirmed deleted",
      }
    }
    return {
      kind: input.deliveryPolicy === "every_run" ? "deliver_result" : "record_quietly",
      summary: deletedSummary.slice(0, 1000),
      reason: "Execution session was confirmed deleted; surfaced clearly instead of reporting empty output",
      issueKey: input.issueKey ?? `deleted:${input.workspaceId}:${input.sourceId}:${input.runKey}`,
    }
  }

  if (input.evidenceIncomplete) {
    const partialHighlight = trimmedOutput ? clipClause(extractUniqueSentences(trimmedOutput).slice(-2).join(" ") || trimmedOutput, 220) : ""
    const incompleteSummary = partialHighlight
      ? `Partial output captured for "${input.sourceTitle}" (full transcript exceeded read limit; final conclusion is unconfirmed — open the original execution session to verify): ${partialHighlight}${prSuffix}`
      : `"${input.sourceTitle}" finished, but its full turn transcript could not be read completely. Open the original execution session to inspect the complete output.${prSuffix}`
    if (input.sourceKind === "session") {
      return {
        kind: "record_quietly",
        reportDelivered: false,
        summary: incompleteSummary.slice(0, 1000),
        ...(detail ? { detail } : {}),
        reason: "Ordinary session transcript was only partially read; preserved link to original session",
      }
    }
    return {
      kind: "deliver_result",
      reportDelivered: false,
      summary: incompleteSummary.slice(0, 1000),
      ...(detail ? { detail } : {}),
      reason: "Scheduled turn transcript was incomplete; surfaced with link to original session instead of treating as empty/clean",
      issueKey: input.issueKey ?? `partial:${input.workspaceId}:${input.sourceId}:${input.runKey}`,
    }
  }

  // Guard against treating opening acknowledgements, progress commentary, or partial milestones
  // as a delivered formal report when no final conclusion was produced.
  if (input.outputSource === "ack" || input.outputSource === "commentary") {
    const stageLabel = input.outputSource === "ack" ? "an opening acknowledgement" : "progress commentary"
    const missingConclusionSummary = `"${input.sourceTitle}" finished, but only ${stageLabel} was recorded and no formal final conclusion was produced. Open the original execution session to inspect the full log.${prSuffix}`
    if (input.sourceKind === "session") {
      return {
        kind: "record_quietly",
        reportDelivered: false,
        summary: missingConclusionSummary.slice(0, 1000),
        ...(detail ? { detail } : {}),
        reason: `Ordinary session turn ended with only ${stageLabel} and no formal final conclusion`,
      }
    }
    return {
      kind: "deliver_result",
      reportDelivered: false,
      summary: missingConclusionSummary.slice(0, 1000),
      ...(detail ? { detail } : {}),
      reason: `Scheduled run ended with only ${stageLabel} and no formal final conclusion`,
      issueKey: input.issueKey ?? `no-final:${input.workspaceId}:${input.sourceId}:${input.runKey}`,
    }
  }

  if (input.outputSource === "milestone") {
    const milestoneHighlight = clipClause(extractUniqueSentences(trimmedOutput).slice(-2).join(" ") || trimmedOutput, 220)
    const milestoneSummary = `"${input.sourceTitle}" finished with only an intermediate milestone and no formal final conclusion (open the original execution session to verify): ${milestoneHighlight}${prSuffix}`
    if (input.sourceKind === "session") {
      return {
        kind: "record_quietly",
        reportDelivered: false,
        summary: milestoneSummary.slice(0, 1000),
        ...(detail ? { detail } : {}),
        reason: "Ordinary session turn ended with only an intermediate milestone and no formal final conclusion",
      }
    }
    return {
      kind: "deliver_result",
      reportDelivered: false,
      summary: milestoneSummary.slice(0, 1000),
      ...(detail ? { detail } : {}),
      reason: "Scheduled run ended with only an intermediate milestone and no formal final conclusion",
      issueKey: input.issueKey ?? `milestone-only:${input.workspaceId}:${input.sourceId}:${input.runKey}`,
    }
  }

  // A completed scheduled run that produced no assistant text at all: keep the explicit notice and the link to
  // the original session, but never count it as a delivered report.
  if (!trimmedOutput && input.sourceKind === "schedule") {
    return {
      kind: "deliver_result",
      reportDelivered: false,
      summary: `Run completed with no text output.${prSuffix}`,
      reason: "Scheduled run completed without any text output; no report was produced",
      issueKey: input.issueKey ?? `no-output:${input.workspaceId}:${input.sourceId}:${input.runKey}`,
    }
  }

  const distilledSummary = summarizeCompletedRunOutput(input)

  // Ordinary session normal completion: record quietly by default unless model/evidence indicates a concrete actionable issue.
  if (input.sourceKind === "session") {
    return {
      kind: "record_quietly",
      summary: distilledSummary,
      ...(detail ? { detail } : {}),
      reason: "Ordinary session turn completed normally; recorded for on-demand query",
    }
  }

  // Schedule completed run: apply user's delivery policy.
  if (input.deliveryPolicy === "every_run") {
    if (options.model) {
      try {
        const raw = await options.model({
          kind: "follow_up_triage",
          sourceKind: "schedule",
          sourceTitle: input.sourceTitle,
          status: input.status,
          deliveryPolicy: input.deliveryPolicy,
          outputText: boundSummaryText(trimmedOutput, 6000),
          prStatusNote: input.prStatusNote,
        }, options.signal)
        const parsed = parseModelDecision(raw, distilledSummary, input)
        if (parsed) {
          return {
            ...parsed,
            kind: parsed.kind === "record_quietly" ? "deliver_result" : parsed.kind,
            ...(detail ? { detail } : {}),
          }
        }
      } catch {
        // Model unavailable: deliver deterministic SA summary so every_run never silently drops.
      }
    }
    return {
      kind: "deliver_result",
      summary: distilledSummary,
      ...(detail ? { detail } : {}),
      reason: "Scheduled delivery policy is every_run",
      issueKey: input.issueKey,
    }
  }

  // exceptions_only schedule: clean/no-change runs stay quiet without model calls; potential anomalies invoke triage model if available.
  if (!input.outputTruncated && looksCleanNoRisk(trimmedOutput)) {
    return {
      kind: "record_quietly",
      summary: distilledSummary,
      ...(detail ? { detail } : {}),
      reason: "No anomalies detected under exceptions_only policy",
    }
  }

  if (options.model) {
    try {
      const raw = await options.model({
        kind: "follow_up_triage",
        sourceKind: "schedule",
        sourceTitle: input.sourceTitle,
        status: input.status,
        deliveryPolicy: input.deliveryPolicy,
        outputText: boundSummaryText(trimmedOutput, 6000),
        prStatusNote: input.prStatusNote,
      }, options.signal)
      const parsed = parseModelDecision(raw, distilledSummary, input)
      if (parsed) return { ...parsed, ...(detail ? { detail } : {}) }
    } catch {
      // Model unavailable: surface the anomaly deterministically so real issues are never missed.
    }
  }

  return {
    kind: "deliver_result",
    summary: distilledSummary,
    ...(detail ? { detail } : {}),
    reason: "Potential finding detected under exceptions_only policy",
    issueKey: input.issueKey ?? `finding:${input.workspaceId}:${input.sourceId}:${computeEvidenceVersion([trimmedOutput.slice(0, 300)])}`,
  }
}

export interface CoordinatorTriageModelDeps {
  superStore: Pick<SuperStateStore, "get">
  providers: () => { id: string; name: string; template?: string }[]
  defaultCoordinator: string
  coordinatorModel: (id: string) => SuperDecisionModel
  coordinatorOptions?: (id: string, model?: string) => Promise<SuperCoordinatorOptions>
}

function tryParseTriageJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const stripped = trimmed.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/iu, "$1").trim()
  try {
    const parsed: unknown = JSON.parse(stripped)
    if (parseModelDecision(parsed, "triage")) return parsed
  } catch { /* try embedded JSON object below */ }
  const firstBrace = stripped.indexOf("{")
  const lastBrace = stripped.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed: unknown = JSON.parse(stripped.slice(firstBrace, lastBrace + 1))
      if (parseModelDecision(parsed, "triage")) return parsed
    } catch { /* invalid JSON falls back to deterministic rule */ }
  }
  return undefined
}

/**
 * Unwrap either a direct triage decision JSON object or a coordinator `superDecisionSchema` envelope
 * (`{ reason, actions: [{ kind: "answer" | "clarify", text: "<json>" }] }`) into a triage decision payload.
 */
export function extractTriageFromCoordinatorDecision(raw: unknown): unknown {
  if (parseModelDecision(raw, "triage")) return raw
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const actions = (raw as { actions?: unknown }).actions
  if (!Array.isArray(actions)) return undefined
  for (const action of actions) {
    if (!action || typeof action !== "object" || Array.isArray(action)) continue
    const rec = action as { kind?: unknown; text?: unknown }
    if ((rec.kind === "answer" || rec.kind === "clarify") && typeof rec.text === "string") {
      const extracted = tryParseTriageJson(rec.text)
      if (extracted) return extracted
    }
  }
  return undefined
}

/**
 * Build the production background follow-up `triageModel` resolver on top of the host's configured
 * Super Agent coordinator runtime (`createCoordinatorRuntime`), sharing provider resolution and
 * per-user coordinator model preferences while keeping inference strictly read-only and schema-safe.
 */
export function createCoordinatorTriageModel(deps: CoordinatorTriageModelDeps): (userId: string) => TriageModel | undefined {
  return (userId: string): TriageModel | undefined => {
    const configured = deps.providers()
    if (!configured.length) return undefined
    const state = deps.superStore.get(userId)
    let chosen: { id: string; name: string; template?: string } | undefined
    if (state?.coordinatorProviderId !== undefined) {
      chosen = configured.find(provider => provider.id === state.coordinatorProviderId)
    } else {
      const preferred = configured.filter(provider => (provider.template ?? provider.id) === deps.defaultCoordinator)
      chosen = preferred.length === 1 ? preferred[0] : configured.length === 1 ? configured[0] : undefined
    }
    if (!chosen) return undefined
    const providerId = chosen.id
    const providerTemplate = chosen.template ?? chosen.id
    const overrides = state?.coordinatorOverrides?.[providerId] ?? {}

    return async (packet, signal) => {
      signal?.throwIfAborted()
      let selection = { ...overrides }
      if (deps.coordinatorOptions) {
        try {
          const catalog = await deps.coordinatorOptions(providerId, overrides.model)
          selection = effectiveCoordinatorProfile(providerTemplate, overrides, catalog)
        } catch {
          selection = { ...overrides }
        }
      }
      const wrappedPacket = {
        mode: "background_follow_up_triage",
        message: [
          "You are the project Super Agent — the user's sole direct window for followed runs. Evaluate the untrusted payload in `triage` and decide whether to stay quiet or summarize the run for the user.",
          "Never request evidence, never call tools, and never dispatch a worker.",
          "Return exactly one `answer` action whose `text` is ONLY a single raw JSON object (no prose, no markdown fences) matching:",
          '{"kind":"record_quietly"|"deliver_result"|"supplement_worker"|"create_ticket"|"ask_human","summary":"concise SA summary in the language of the report","reason":"short factual basis","issueKey":"optional stable issue key"}',
          "Requirements for `summary`: synthesize based strictly on THIS run's actual content, clearly covering (1) what conclusion was reached, (2) what is incomplete/failed/unverified (if any), and (3) whether user action or decision is needed. NEVER use a bare status label, NEVER paste the full raw report or markdown tables verbatim, and NEVER output raw truncation boilerplate — full details stay in the expandable execution card.",
          'For status="failed" or "interrupted", NEVER choose "record_quietly" and NEVER report the run as clean or succeeded.',
          'Under deliveryPolicy="exceptions_only", choose kind="record_quietly" ONLY when the entire report is clearly normal/within thresholds with no anomaly, failure, risk, or needed action; otherwise choose kind="deliver_result" (or "ask_human" if a user choice is needed) highlighting the exact anomaly or metric breach.',
        ].join("\n"),
        triage: packet,
      }
      const hasSelection = !!(selection.model || selection.reasoningEffort)
      const raw = await deps.coordinatorModel(providerId)(
        wrappedPacket,
        signal,
        undefined,
        hasSelection ? { selection } : undefined,
      )
      return extractTriageFromCoordinatorDecision(raw)
    }
  }
}
