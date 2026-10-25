import type { ProviderIcon } from "./provider-icons.ts"

// Keep the library's square monochrome marks; wordmarks and color variants are
// separate files. Bundled SVG data works offline and follows the app's theme.
export function iconsFrom(marks: Record<string, string>): ProviderIcon[] {
  return Object.entries(marks).map(([path, svg]) => ({
    id: path.split("/").at(-1)!.slice(0, -4),
    name: svg.match(/<title>(.*?)<\/title>/u)![1]!.replaceAll("&amp;", "&"),
    url: `data:image/svg+xml,${encodeURIComponent(svg)}`,
  }))
}
