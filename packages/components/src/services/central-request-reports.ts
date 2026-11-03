import { CentralRequestError } from "@deskfleet/client/request-diagnostics"
import { centralRequestFingerprint } from "./central-request-event.ts"

interface Repetition { occurrences: number; window_ms: number; summary: boolean }
interface Bucket { latest: CentralRequestError; suppressed: number; started: number; timer: ReturnType<typeof setTimeout> }
const windowMs = 60_000
const maxBuckets = 128

/** One document's background bursts; each request is represented in an occurrence count. */
export class CentralRequestReports {
  private readonly buckets = new Map<string, Bucket>()
  private readonly seen = new WeakSet<CentralRequestError>()
  private readonly emit: (error: CentralRequestError, repetition: Repetition) => void

  constructor(emit: (error: CentralRequestError, repetition: Repetition) => void) { this.emit = emit }

  capture(error: CentralRequestError): void {
    if (this.seen.has(error)) return
    this.seen.add(error)
    const { trigger, kind, status } = error.diagnostics
    const background = trigger === "background" && (kind === "network" || kind === "timeout" || kind === "http" && (status === 429 || status! >= 500))
    if (!background) { this.emit(error, { occurrences: 1, window_ms: 0, summary: false }); return }
    const key = JSON.stringify(centralRequestFingerprint(error.diagnostics))
    const existing = this.buckets.get(key)
    if (existing) { existing.latest = error; existing.suppressed++; return }
    if (this.buckets.size >= maxBuckets) this.finish(this.buckets.keys().next().value!)
    this.buckets.set(key, { latest: error, suppressed: 0, started: Date.now(), timer: setTimeout(() => this.finish(key), windowMs) })
    this.emit(error, { occurrences: 1, window_ms: 0, summary: false })
  }

  private finish(key: string): void {
    const bucket = this.buckets.get(key)
    if (!bucket) return
    clearTimeout(bucket.timer)
    this.buckets.delete(key)
    if (!bucket.suppressed) return
    // A later unhandled hook may already have captured the latest Error. Give
    // this separate count summary its own identity without copying raw causes.
    const error = new CentralRequestError(bucket.latest.message, structuredClone(bucket.latest.diagnostics))
    error.stack = bucket.latest.stack
    try { this.emit(error, { occurrences: bucket.suppressed, window_ms: Date.now() - bucket.started, summary: true }) }
    catch { /* A timer or pagehide handler must not throw a reporting failure. */ }
  }

  flush(): void { for (const key of this.buckets.keys()) this.finish(key) }
}
