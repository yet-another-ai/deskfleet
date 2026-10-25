export interface ProviderIcon {
  id: string
  name: string
  url: string
}

// Keep the library's square monochrome marks; wordmarks and color variants are
// separate files. Bundled SVG data works offline and follows the app's theme.
const marks = import.meta.glob<string>([
  "../../node_modules/@lobehub/icons-static-svg/icons/*.svg",
  "!../../node_modules/@lobehub/icons-static-svg/icons/*-*.svg",
], { eager: true, query: "?raw", import: "default" })

const favorites = ["openai", "codex", "claude", "claudecode", "gemini", "deepseek", "qwen", "pi", "cursor", "githubcopilot", "grok", "ollama", "mistral", "kimi"]
export const providerIcons: ProviderIcon[] = Object.entries(marks).map(([path, svg]) => ({
  id: path.split("/").at(-1)!.slice(0, -4),
  name: svg.match(/<title>(.*?)<\/title>/u)![1]!.replaceAll("&amp;", "&"),
  url: `data:image/svg+xml,${encodeURIComponent(svg)}`,
})).sort((a, b) => {
  const left = favorites.indexOf(a.id)
  const right = favorites.indexOf(b.id)
  return (left < 0 ? favorites.length : left) - (right < 0 ? favorites.length : right) || a.name.localeCompare(b.name)
})

const iconsById = new Map(providerIcons.map(icon => [icon.id, icon]))

const templateIcons: Record<string, string> = { codex: "openai", "claude-code": "claudecode", cursor: "cursor", grok: "grok" }

export function iconForProvider(icon?: string, template?: string): ProviderIcon | undefined {
  return (icon ? iconsById.get(icon) : undefined) ?? (template ? iconsById.get(templateIcons[template] ?? "") : undefined)
}
