import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { computed } from "vue"
import docxUrl from "../../test/fixtures/office/preview.docx?url"
import pptxUrl from "../../test/fixtures/office/preview.pptx?url"
import xlsxUrl from "../../test/fixtures/office/preview.xlsx?url"
import PreviewViewer from "./PreviewViewer.vue"

const word = {
  kind: "docx",
  content: docxUrl,
  title: "preview.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const

const excel = {
  kind: "xlsx",
  content: xlsxUrl,
  title: "preview.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const

const powerpoint = {
  kind: "pptx",
  content: pptxUrl,
  title: "preview.pptx",
  mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const

const meta = {
  title: "Domain/Markdown & Diagrams/OfficePreview",
  component: PreviewViewer,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  args: { ...word, mode: "tab" },
  render: args => ({
    components: { PreviewViewer },
    setup() {
      // Vite asset paths are browser URLs, not paths on the session's machine.
      const content = computed(() => new URL(args.content, window.location.href).href)
      const frameStyle = computed(() => ({
        width: "100%",
        maxWidth: args.mode === "focus" ? "none" : args.mode === "inline" ? "640px" : "800px",
        height: args.mode === "focus" ? "calc(100vh - 32px)" : args.mode === "inline" ? "420px" : "620px",
        minHeight: "360px",
      }))
      return { args, content, frameStyle }
    },
    template: `<div class="flex min-h-0 flex-col" :style="frameStyle"><PreviewViewer v-bind="args" :content="content" class="h-full min-h-0" /></div>`,
  }),
} satisfies Meta<typeof PreviewViewer>

export default meta
type Story = StoryObj<typeof meta>

export const WordTab: Story = {}
export const ExcelTab: Story = { args: excel }
export const PowerPointTab: Story = { args: powerpoint }

export const WordInline: Story = { args: { ...word, mode: "inline" } }
export const ExcelInline: Story = { args: { ...excel, mode: "inline" } }
export const PowerPointInline: Story = { args: { ...powerpoint, mode: "inline" } }

export const WordFullscreen: Story = { args: { ...word, mode: "focus" } }
export const ExcelFullscreen: Story = { args: { ...excel, mode: "focus" } }
export const PowerPointFullscreen: Story = { args: { ...powerpoint, mode: "focus" } }

export const CorruptDocument: Story = {
  args: {
    ...word,
    content: `data:${word.mimeType};base64,UEsDBA==`,
    data: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    title: "corrupt.docx",
  },
}
