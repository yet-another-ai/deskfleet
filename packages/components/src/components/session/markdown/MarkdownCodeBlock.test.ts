import { flushPromises, mount } from "@vue/test-utils"
import { expect, test } from "vitest"
import { i18n } from "../../../i18n/index.ts"
import MarkdownCodeBlock from "./MarkdownCodeBlock.vue"
import MarkdownCodeTokens from "./MarkdownCodeTokens.vue"

test("streamed code retains completed chunks and updates the highlighted tail and copy text", async () => {
  let code = 'const value = "hello";\n'.repeat(200)
  const view = mount(MarkdownCodeBlock, { props: { node: { language: "typescript", code } }, global: { plugins: [i18n] } })
  try {
    await flushPromises()
    const firstChunk = view.findComponent(MarkdownCodeTokens)
    const tokens = firstChunk.props("tokens")
    const firstElement = firstChunk.element
    for (const delta of ["const next", " = ", '"world";', "\n", "// done\n"]) {
      code += delta
      await view.setProps({ node: { language: "typescript", code } })
      await flushPromises()
      expect(view.get("pre code").element.textContent?.replace(/\n/g, "")).toBe(code.replace(/\n/g, ""))
      expect(view.findAll("pre code br")).toHaveLength((code.replace(/\n$/u, "").match(/\n/g) ?? []).length)
      expect(view.get("button").attributes("data-code-copy")).toBe(code.replace(/\n$/u, ""))
      expect(view.findComponent(MarkdownCodeTokens).props("tokens")).toBe(tokens)
      expect(view.findComponent(MarkdownCodeTokens).element).toBe(firstElement)
    }
  } finally {
    view.unmount()
  }
})

test("replaces chunks when code is rewritten, cleared, or its language changes", async () => {
  const view = mount(MarkdownCodeBlock, { props: { node: { language: "typescript", code: "const previous = 1;\n".repeat(100) } }, global: { plugins: [i18n] } })
  try {
    await flushPromises()
    for (const node of [
      { language: "typescript", code: "const replacement = 2;\n" },
      { language: "python", code: "print('new')" },
      { language: "unknown", code: "plain text" },
      { language: "typescript", code: "" },
      { language: "typescript", code: "const final = 3;" },
    ]) {
      await view.setProps({ node })
      await flushPromises()
      expect(view.get("pre code").element.textContent).toBe(node.code.replace(/\n$/u, ""))
    }
  } finally {
    view.unmount()
  }
})
