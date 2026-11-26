import type { Meta, StoryObj } from "@storybook/vue3-vite"
import PreviewViewer from "./PreviewViewer.vue"

const flowchartCode = `flowchart LR
  Client["Desktop Client"] --> Peer["WebRTC DataChannel"]
  Peer --> Daemon["Local Daemon"]
  Daemon --> ACP["Agent Provider (ACP)"]
  Daemon --> Git["Git Worktree"]`

const meta = {
  title: "Domain/Markdown & Diagrams/MermaidPreview",
  component: PreviewViewer,
  tags: ["autodocs"],
  args: {
    kind: "mermaid",
    text: flowchartCode,
    mode: "inline",
    source: {
      sessionId: "sess-1",
      entryId: "message-5",
      itemId: "mermaid-0",
    },
  },
} satisfies Meta<typeof PreviewViewer>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
