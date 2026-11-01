import { app, BrowserWindow, contentTracing } from "electron"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

interface Configuration { url: string; output: string; turns: number[]; rounds: number; chunks: number; intervalMs: number; expanded: boolean; scroll: string; profile: boolean; trace: boolean; capture?: boolean; isolated?: { renderer: string; corpus: string; repeats: number } }
const config: Configuration = JSON.parse(process.argv[2]!)
app.setPath("userData", resolve(config.output, "electron-profile"))
app.commandLine.appendSwitch("disable-renderer-backgrounding")
app.commandLine.appendSwitch("disable-background-timer-throttling")
app.on("window-all-closed", () => {})
async function main(): Promise<void> {
 await app.whenReady()
 const results: unknown[] = []
 try {
  for (const turns of config.turns) {
    for (let round = 0; round < config.rounds; round++) {
      const window = new BrowserWindow({ show: false, width: 1280, height: 900, useContentSize: true,
        webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true },
      })
      try {
        window.webContents.setFrameRate(60)
        const capturePrefix = "__deskfleet_scrollback_capture__:"
        window.webContents.on("console-message", event => {
          if (event.level === "error") console.error(event.message)
          if (!config.capture || !event.message.startsWith(capturePrefix)) return
          const name = event.message.slice(capturePrefix.length)
          void (async () => {
            let failure: string | undefined
            try {
              if (!["top", "middle", "bottom", "located-thought"].includes(name)) throw new Error(`Unknown screenshot checkpoint: ${name}`)
              // rAF runs before paint, and the first delivered image may already
              // be in flight. Wait for paint, then request a fresh screenshot.
              await new Promise<void>(done => {
                window.webContents.once("paint", () => done())
                window.webContents.invalidate()
              })
              const screenshot = await window.webContents.capturePage()
              await writeFile(resolve(config.output, `${turns}-${round + 1}-scrollback-${name}.png`), screenshot.toPNG())
            } catch (error) { failure = String(error) }
            await window.webContents.executeJavaScript(failure
              ? `window.__scrollbackCapture.reject(new Error(${JSON.stringify(failure)}))`
              : "window.__scrollbackCapture.resolve()")
          })().catch(error => { console.error(error); window.destroy() })
        })
        await window.loadURL(config.url)
        await window.webContents.executeJavaScript("window.benchmarkReady")
        if (config.capture) await window.webContents.executeJavaScript(`
          window.captureConversationScrollback = name => new Promise((resolve, reject) => {
            window.__scrollbackCapture = { resolve, reject };
            console.info(${JSON.stringify(capturePrefix)} + name);
          });
          void 0;
        `)
        if (config.trace) await contentTracing.startRecording({ included_categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "blink.user_timing"] })
        if (config.profile) {
          window.webContents.debugger.attach("1.3")
          await window.webContents.debugger.sendCommand("Profiler.enable")
          await window.webContents.debugger.sendCommand("Profiler.start")
        }
        const options = { turns, chunks: config.chunks, intervalMs: config.intervalMs, expanded: config.expanded, scroll: config.scroll }
        const result = await Promise.race([
          window.webContents.executeJavaScript(config.isolated
            ? `window.runIsolatedMarkdownBenchmark(${JSON.stringify({ ...config.isolated, chunks: config.chunks, intervalMs: config.intervalMs })})`
            : `window.runConversationBenchmark(${JSON.stringify(options)})`),
          new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Benchmark exceeded 180 seconds")), 180_000); timer.unref() }),
        ])
        results.push({ ...options, round: round + 1, electron: process.versions.electron, chrome: process.versions.chrome, ...result })
        if (config.trace) await contentTracing.stopRecording(resolve(config.output, `${turns}-${round + 1}.pftrace`))
        await writeFile(resolve(config.output, "results.json"), JSON.stringify(results, null, 2))
        if (config.profile) {
          const { profile } = await window.webContents.debugger.sendCommand("Profiler.stop")
          await writeFile(resolve(config.output, `${turns}-${round + 1}.cpuprofile`), JSON.stringify(profile))
        }
        console.log(`Completed ${turns} historical turns, round ${round + 1}/${config.rounds}`)
      } finally { window.destroy() }
    }
  }
  app.exit(0)
 } catch (error) {
  console.error(error)
  app.exit(1)
 }
}
void main()
