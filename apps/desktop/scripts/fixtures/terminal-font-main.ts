import { app, BrowserWindow } from "electron"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { TerminalFontResult } from "../../../../packages/components/scripts/fixtures/terminal-font-renderer.ts"

app.commandLine.appendSwitch("force-device-scale-factor", "2")
process.on("message", () => app.quit())
process.on("disconnect", () => app.quit())
void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false, width: 800, height: 460,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  await window.loadFile(join(import.meta.dirname, "index.html"))
  const result = await window.webContents.executeJavaScript("window.runTerminalFontSmoke()") as TerminalFontResult
  await writeFile(join(import.meta.dirname, "results.json"), JSON.stringify({ electron: process.versions.electron, ...result }, null, 2) + "\n")
  await writeFile(join(import.meta.dirname, "terminal.png"), (await window.webContents.capturePage()).toPNG())
  process.send?.({ result })
}).catch(error => { process.send?.({ error: String(error) }); app.quit() })
