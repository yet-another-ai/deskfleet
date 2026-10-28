/** Lazy Shiki highlighting for agent Markdown fences. Languages load on demand. */

export async function highlightCode(code: string, lang: string): Promise<string | undefined> {
  try {
    const { bundledLanguages, codeToHtml } = await import("shiki")
    const resolved = lang && lang in bundledLanguages ? lang : "text"
    return await codeToHtml(code, {
      lang: resolved,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    })
  } catch {
    return undefined
  }
}
