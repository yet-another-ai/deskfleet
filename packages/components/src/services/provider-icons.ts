export interface ProviderIcon {
  id: string
  name: string
  url: string
}

const templateIcons: Record<string, string> = { codex: "openai", "claude-code": "claudecode", cursor: "cursor", grok: "grok", pi: "pi" }

export interface ProviderIconCatalog {
  providerIcons: readonly ProviderIcon[]
  iconsById: ReadonlyMap<string, ProviderIcon>
}

const favorites = ["openai", "codex", "claude", "claudecode", "gemini", "deepseek", "qwen", "pi", "cursor", "githubcopilot", "grok", "ollama", "mistral", "kimi"]

let loading: Promise<ProviderIconCatalog> | undefined

/** The mark catalog is hundreds of inlined SVGs, so it loads apart from the shell. */
export function loadProviderIcons(): Promise<ProviderIconCatalog> {
  loading ??= Promise.all([
    import("./provider-icon-catalog-a.ts"),
    import("./provider-icon-catalog-b.ts"),
  ]).then(([first, second]) => {
    const providerIcons = [...first.providerIcons, ...second.providerIcons].sort((a, b) => {
      const left = favorites.indexOf(a.id)
      const right = favorites.indexOf(b.id)
      return (left < 0 ? favorites.length : left) - (right < 0 ? favorites.length : right) || a.name.localeCompare(b.name)
    })
    return { providerIcons, iconsById: new Map(providerIcons.map(icon => [icon.id, icon])) }
  })
  return loading
}

export function matchProviderIcon(icons: ReadonlyMap<string, ProviderIcon>, icon?: string, template?: string): ProviderIcon | undefined {
  return (icon ? icons.get(icon) : undefined) ?? (template ? icons.get(templateIcons[template] ?? "") : undefined)
}
