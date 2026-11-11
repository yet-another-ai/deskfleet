import { execFile } from "node:child_process"
import type { AuvPermissionsState } from "../../../../packages/client/src/onboarding.ts"

function failure(error: string): AuvPermissionsState { return { status: "error", error } }

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function permissionsState(stdout: string, requested: boolean): AuvPermissionsState {
  let value: unknown
  try { value = JSON.parse(stdout) }
  catch { return failure("AUV returned an invalid authorization report. Try again.") }
  const report = record(value)
  if (!report || report.app_id !== "ai.moeru.auv"
    || typeof report.desktop_entry_installed !== "boolean"
    || typeof report.identity_registered !== "boolean"
    || (report.identity_error !== null && typeof report.identity_error !== "string")
    || typeof report.capture_token_present !== "boolean"
    || typeof report.input_token_present !== "boolean") {
    return failure("AUV returned an invalid authorization report. Try again.")
  }
  if (!report.desktop_entry_installed || !report.identity_registered || report.identity_error !== null) {
    return failure("AUV's desktop identity is not registered. Request authorization to set it up.")
  }
  const interfaces = record(report.interfaces)
  if (record(interfaces?.screencast)?.available === "missing"
    || record(interfaces?.remote_desktop)?.available === "missing") {
    return failure("The desktop does not provide the screen sharing and input Portals required by AUV.")
  }
  // Saved restore tokens can still be revoked by the desktop; they are not a live permission check.
  if (report.capture_token_present && report.input_token_present) return { status: "saved" }
  return requested
    ? failure("The desktop did not save screen and input authorization. It may ask again when AUV is used. Try again or skip this step.")
    : { status: "not-requested" }
}

/** AUV owns Portal consent and persistence; the desktop host only launches its supported doctor commands. */
export class AuvPermissionsController {
  readonly #binary: string
  readonly #abort = new AbortController()
  #pending?: Promise<AuvPermissionsState>

  constructor(binary: string) { this.#binary = binary }

  get(): Promise<AuvPermissionsState> {
    if (this.#abort.signal.aborted) return Promise.resolve(this.#closed())
    if (this.#pending) return Promise.resolve({ status: "requesting" })
    return this.#execute(false)
  }

  request(): Promise<AuvPermissionsState> {
    if (this.#abort.signal.aborted) return Promise.resolve(this.#closed())
    this.#pending ??= this.#execute(true).finally(() => { this.#pending = undefined })
    return this.#pending
  }

  close(): void { this.#abort.abort() }

  #closed(): AuvPermissionsState { return failure("AUV authorization is unavailable because the application is closing.") }

  async #execute(requested: boolean): Promise<AuvPermissionsState> {
    const args = requested ? ["doctor", "--portal-setup", "--portal-authorize", "--json"] : ["doctor", "--json"]
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(this.#binary, args, {
          encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024,
          timeout: requested ? 150_000 : 30_000,
          signal: this.#abort.signal,
        }, (error, output) => { if (error) reject(error); else resolve(output) })
      })
      return this.#abort.signal.aborted ? this.#closed() : permissionsState(stdout, requested)
    } catch {
      if (this.#abort.signal.aborted) return this.#closed()
      // Child-process errors can contain stdout/stderr. Keep diagnostic payloads out of renderer state.
      return failure(requested
        ? "AUV authorization did not complete. Approve the desktop prompts and try again."
        : "Could not check AUV authorization. Try again.")
    }
  }
}
