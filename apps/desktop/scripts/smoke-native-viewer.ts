import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { spawnDesktopViewerChild } from "../src/main/native-desktop-process.ts"

// Opens a real native window using 64x64 H.264/HEVC/AV1 fixture frames. Set
// DESKFLEET_SMOKE_HARDWARE=1 to encode generated 320x240 pixels with the host's
// hardware encoder. Neither mode captures a desktop or requests permissions.
// The viewer uses its normal decoder selection. Explicit diagnostic decoder
// settings are inherited, so software and hardware runs remain distinguishable.
// DESKFLEET_SMOKE_DURATION_SECONDS observes the valid stream for 1..300 seconds.
// DESKFLEET_SMOKE_VIEWER can point at the executable inside a packaged app.
const root = resolve(import.meta.dirname, "../../..")
const hardware = process.env.DESKFLEET_SMOKE_HARDWARE === "1"
const codec = process.env.DESKFLEET_SMOKE_CODEC ?? "h264"
assert.ok(["h264", "h265", "av1"].includes(codec), "unsupported smoke codec")
assert.ok(!hardware || process.platform === "linux", "generated hardware smoke requires Linux")
const durationSeconds = Number(process.env.DESKFLEET_SMOKE_DURATION_SECONDS ?? "1")
assert.ok(Number.isInteger(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 300,
  "DESKFLEET_SMOKE_DURATION_SECONDS must be an integer from 1 to 300")
const suffix = process.platform === "win32" ? ".exe" : ""
const processes: { child: ChildProcessWithoutNullStreams; kind: "viewer" | "source"; exited: Promise<void> }[] = []
let diagnostics = ""
let complete = false
let connected = false
let failed = false
let result: Stats | undefined

function launch(kind: "viewer" | "source", executable: string): ChildProcessWithoutNullStreams {
  const child = kind === "viewer" ? spawnDesktopViewerChild(executable) : spawn(executable, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, DESKFLEET_SMOKE_CAPTURE: "0", DESKFLEET_SMOKE_HARDWARE: hardware ? "1" : "0", DESKFLEET_SMOKE_WINDOWS_SERVICE: "0", DESKFLEET_SMOKE_VIDEO_ONLY: "1", DESKFLEET_SMOKE_CODEC: codec },
  })
  const exited = new Promise<void>(resolveExit => { child.once("close", () => resolveExit()) })
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { diagnostics = (diagnostics + `[${kind}] ${chunk}`).slice(-32_768) })
  processes.push({ child, kind, exited })
  return child
}

interface Candidate { candidate: string; sdpMid?: string | null; sdpMlineIndex?: number | null; sdpMLineIndex?: number | null; usernameFragment?: string | null }
interface Stats {
  decodedFrames: number; submittedFrames: number; droppedFrames: number
  width: number; height: number; maxCandidates?: number
  presentationMode?: string; presentedCommits?: number | null
  observedMs?: number
}

try {
  const viewer = launch("viewer", process.env.DESKFLEET_SMOKE_VIEWER ?? join(root, "target/debug", `deskfleet-viewer${suffix}`))
  const source = launch("source", join(root, "target/debug/examples", `media_smoke${suffix}`))
  const viewerLines = createInterface({ input: viewer.stdout }), sourceLines = createInterface({ input: source.stdout })
  result = await new Promise<Stats>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => fail(new Error("Native viewer smoke timed out")), 30_000 + durationSeconds * 1000)
    const send = (child: ChildProcessWithoutNullStreams, value: unknown) => { if (!complete) child.stdin.write(`${JSON.stringify(value)}\n`) }
    function fail(error: unknown): void {
      if (complete) return
      complete = true
      clearTimeout(timer)
      rejectResult(error)
    }
    for (const { child, kind } of processes) {
      child.once("error", fail)
      child.stdin.on("error", fail)
      child.once("exit", (code, signal) => fail(new Error(`${kind} exited early (${signal ?? code})`)))
    }
    let offered = false, answered = false, answerApplied = false, inputReady = false
    let observationStarted: number | undefined
    const localCandidates: Candidate[] = [], remoteCandidates: Candidate[] = []
    const sendLocal = (value: Candidate) => {
      const { sdpMlineIndex, sdpMLineIndex, ...candidate } = value
      send(source, { kind: "candidate", candidate: { ...candidate, sdpMLineIndex: sdpMlineIndex ?? sdpMLineIndex } })
    }
    const sendRemote = (value: Candidate) => {
      const { sdpMLineIndex, sdpMlineIndex, ...candidate } = value
      send(viewer, { type: "candidate", candidate: { ...candidate, sdpMlineIndex: sdpMlineIndex ?? sdpMLineIndex } })
    }
    viewerLines.on("line", line => {
      try {
        const event = JSON.parse(line) as { type: string; codecs?: string[]; sdp?: string; candidate?: Candidate; error?: string } & Stats
        switch (event.type) {
          case "capabilities":
            assert.ok(event.codecs?.includes(codec), `native decoder does not support ${codec}`)
            send(viewer, { type: "start", title: `DeskFleet ${codec} native viewer smoke`, codec,
              width: hardware ? 320 : 64, height: hardware ? 240 : 64, iceServers: [], relayOnly: false, control: true })
            break
          case "offer":
            assert.ok(event.sdp?.toLowerCase().includes(`${codec}/90000`), `viewer must negotiate ${codec}`)
            send(source, { kind: "offer", sdp: event.sdp })
            offered = true
            for (const candidate of localCandidates.splice(0)) sendLocal(candidate)
            break
          case "candidate":
            assert.ok(event.candidate)
            if (offered) sendLocal(event.candidate)
            else localCandidates.push(event.candidate)
            break
          case "connected": connected = true; break
          case "inputReady": inputReady = true; break
          case "answerApplied":
            assert.ok(answered, "viewer must apply the signaled answer")
            answerApplied = true
            for (const candidate of remoteCandidates.splice(0)) sendRemote(candidate)
            break
          case "error": throw new Error(event.error ?? "Native viewer failed")
          case "closed": throw new Error("Native viewer closed before receiving frames")
          case "stats":
            if (!answerApplied || !inputReady || !connected || typeof event.decodedFrames !== "number" || event.decodedFrames < 3
              || typeof event.submittedFrames !== "number" || event.submittedFrames < 3) break
            assert.equal(event.width, hardware ? 320 : 64)
            assert.equal(event.height, hardware ? 240 : 64)
            if (event.maxCandidates !== undefined) assert.ok(event.maxCandidates <= 2, "candidate queue exceeded two frames")
            if (event.presentationMode === "wayland-presentation"
              && (typeof event.presentedCommits !== "number" || event.presentedCommits < 3)) break
            observationStarted ??= performance.now()
            const observedMs = performance.now() - observationStarted
            if (observedMs < durationSeconds * 1000) break
            complete = true
            clearTimeout(timer)
            resolveResult({ ...event, observedMs })
            break
        }
      } catch (error) { fail(error) }
    })
    sourceLines.on("line", line => {
      try {
        const event = JSON.parse(line) as { kind: string; sdp?: string; candidate?: Candidate; error?: string }
        if (event.kind === "answer") {
          assert.ok(event.sdp)
          send(viewer, { type: "answer", sdp: event.sdp })
          answered = true
        } else if (event.kind === "candidate") {
          assert.ok(event.candidate)
          if (answerApplied) sendRemote(event.candidate)
          else remoteCandidates.push(event.candidate)
        } else if (event.kind === "error") throw new Error(event.error ?? "Fixture sender failed")
      } catch (error) { fail(error) }
    })
  }).finally(() => { viewerLines.close(); sourceLines.close() })
} catch (error) {
  failed = true
  if (diagnostics) console.error(diagnostics)
  throw error
} finally {
  complete = true
  const cleanup = await Promise.allSettled(processes.map(async ({ child, kind, exited }) => {
    let forced = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end(`${JSON.stringify(kind === "viewer" ? { type: "close" } : { kind: "close" })}\n`)
      timeout = setTimeout(() => { forced = child.kill("SIGKILL") }, 5_000)
    }
    await exited
    clearTimeout(timeout)
    assert.equal(forced, false, `${kind} required forced termination`)
    assert.equal(child.signalCode, null, `${kind} terminated by ${child.signalCode}`)
    assert.equal(child.exitCode, 0, `${kind} did not exit successfully`)
  }))
  const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason)
  if (failures.length) {
    const error = new AggregateError(failures, "Native viewer smoke cleanup failed")
    if (failed) console.error(error)
    else throw error
  }
}
assert.ok(result)
const presentation = result.presentationMode === "wayland-presentation" ? " and Wayland presentation acknowledgements" : ""
console.log(`Native WebRTC viewer: ${hardware ? "generated hardware" : "fixture"} ${codec} receive, decode, input readiness, GPU submission${presentation}, and clean shutdown passed`, result)
