import { Terminal } from "@xterm/xterm"
import { WebglAddon } from "@xterm/addon-webgl"
import { DEFAULT_TERMINAL_FONT } from "../../../client/src/appearance.ts"
import "@xterm/xterm/css/xterm.css"

export interface TerminalFontResult {
  devicePixelRatio: number
  samples: { label: string; expected: string; fonts: string[] }[]
}

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

async function runTerminalFontSmoke(): Promise<TerminalFontResult> {
  const samples: TerminalFontResult["samples"] = []
  const fillText = CanvasRenderingContext2D.prototype.fillText
  let observed: Set<string> | undefined
  // Observe the font used when the real WebGL atlas rasterizes our test glyph.
  // Reading ctx.font afterwards misses failures because xterm restores canvas state.
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
    if (text === "Ω") observed?.add(this.font)
    return maxWidth === undefined ? fillText.call(this, text, x, y) : fillText.call(this, text, x, y, maxWidth)
  }
  try {
    for (const [name, family] of [["Default font", DEFAULT_TERMINAL_FONT], ["Custom font", '"Courier New", monospace']] as const) {
      const heading = document.createElement("h2")
      heading.textContent = `${name}: normal, bold, italic, then normal again`
      const container = document.createElement("div")
      document.body.append(heading, container)
      const terminal = new Terminal({ allowProposedApi: true, cols: 90, rows: 7, fontFamily: family, fontSize: 13, theme: { background: "#2e3440", foreground: "#d8dee9" } })
      terminal.open(container)
      // Loading must succeed: DOM fallback would conceal this GPU-rendering regression.
      const webgl = new WebglAddon()
      terminal.loadAddon(webgl)
      await frame()
      for (const [style, ansi, font] of [
        ["normal", "0", "normal"],
        ["bold", "1", "bold"],
        ["italic", "3", "italic"],
        ["normal after italic", "0", "normal"],
      ] as const) {
        observed = new Set()
        terminal.clearTextureAtlas()
        await new Promise<void>(resolve => terminal.write(`\x1b[${ansi}mΩ Quick terminal font check: 0123456789 -> !=\x1b[0m\r\n`, resolve))
        await frame()
        await frame()
        const expected = document.createElement("canvas").getContext("2d")!
        expected.font = `${font} ${13 * devicePixelRatio}px ${family}`
        samples.push({ label: `${name}, ${style}`, expected: expected.font, fonts: [...observed] })
        // Start each style with an empty screen so previous lines cannot affect observations.
        terminal.clear()
      }
      observed = undefined
      terminal.clear()
      await new Promise<void>(resolve => terminal.write("Normal: Quick terminal font check 0123456789\r\n\x1b[1mBold: Quick terminal font check\x1b[0m\r\n\x1b[3mItalic: Quick terminal font check\x1b[0m\r\nNormal again: Quick terminal font check", resolve))
    }
    await frame()
    await frame()
    return { devicePixelRatio, samples }
  } finally { CanvasRenderingContext2D.prototype.fillText = fillText }
}

Object.assign(window, { runTerminalFontSmoke })
