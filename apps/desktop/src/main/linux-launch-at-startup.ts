import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

function quoteExecArgument(value: string): string {
  // Exec quoting is decoded after Desktop Entry string escapes. Escape both
  // layers, and keep literal percent signs from becoming field codes.
  const quoted = `"${value.replace(/["`$\\]/g, "\\$&").replace(/%/g, "%%")}"`
  return quoted.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
}

function launchCommand(executablePath: string): string {
  const executable = quoteExecArgument(executablePath)
  // GIO checks that argv[0] exists before expanding %% to %. Keep paths with
  // percent signs in a positional argument to a fixed script. Passing the path
  // as data also avoids interpreting '=' as an env assignment or shell syntax.
  return executablePath.includes("%") ? `sh -c ${quoteExecArgument('exec "$1"')} deskfleet ${executable}` : executable
}

/** The user's XDG autostart entry is the source of truth for this preference. */
export class LinuxLaunchAtStartup {
  readonly #path: string
  readonly #executablePath: string

  constructor(path: string, executablePath: string) {
    this.#path = path
    this.#executablePath = executablePath
  }

  get(): boolean {
    return this.#read()?.enabled ?? false
  }

  set(enabled: boolean): boolean {
    if (enabled) {
      this.#write([
        "[Desktop Entry]",
        "Type=Application",
        "Name=DeskFleet",
        `Exec=${launchCommand(this.#executablePath)}`,
        "Terminal=false",
        "",
      ].join("\n"))
    } else {
      rmSync(this.#path, { force: true })
    }
    return this.get()
  }

  refresh(): void {
    const entry = this.#read()
    if (!entry?.enabled) return
    const executable = launchCommand(this.#executablePath)
    if (entry.exec === executable) return
    // Only replace our launch command; retain desktop-specific preferences and
    // never recreate entries removed or disabled outside the app.
    entry.lines[entry.execIndex] = `Exec=${executable}`
    this.#write(entry.lines.join("\n"))
  }

  #read() {
    let contents: string
    try {
      contents = readFileSync(this.#path, "utf8")
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
      throw error
    }
    const lines = contents.split(/\r?\n/)
    const values = new Map<string, string>()
    let inEntry = false
    let execIndex = -1
    for (const [index, raw] of lines.entries()) {
      const line = raw.trim()
      if (line.startsWith("[")) {
        inEntry = line === "[Desktop Entry]"
      } else if (inEntry && !line.startsWith("#")) {
        const separator = line.indexOf("=")
        if (separator < 0) continue
        const key = line.slice(0, separator).trim()
        values.set(key, line.slice(separator + 1).trim())
        if (key === "Exec") execIndex = index
      }
    }
    const exec = values.get("Exec")
    return {
      lines, execIndex, exec,
      enabled: values.get("Type") === "Application" && Boolean(exec)
        && values.get("Hidden") !== "true"
        && values.get("X-GNOME-Autostart-enabled") !== "false",
    }
  }

  #write(contents: string): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 })
    const temporary = `${this.#path}.tmp`
    writeFileSync(temporary, contents, { mode: 0o600 })
    renameSync(temporary, this.#path)
  }
}
