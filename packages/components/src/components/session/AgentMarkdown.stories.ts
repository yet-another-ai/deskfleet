import type { Meta, StoryObj } from "@storybook/vue3-vite"
import AgentMarkdown from "./AgentMarkdown.vue"

const sampleMarkdown = `### Agent Markdown Renderer

Supports **GitHub Flavored Markdown**, syntax-highlighted code blocks via \`shiki\`, KaTeX math equations, and embedded Mermaid diagrams:

\`\`\`ts
export function calculateThroughput(batchSize: number, seqLen: number): number {
  return (batchSize * seqLen) / 42
}
\`\`\`

| Feature | Engine | Status |
| :--- | :--- | :---: |
| Code Highlighting | \`shiki\` | Ready |
| Math Rendering | \`katex\` | Ready |
| Diagrams | \`mermaid\` | Ready |

Inline latency bound $\\tau = \\alpha + \\beta \\cdot N_{\\text{tokens}}$ scales linearly with context length:

$$
\\text{Throughput}(B) = \\frac{B \\cdot L}{T_{\\text{prefill}}(B, L) + T_{\\text{decode}}(B, L)}
$$

\`\`\`mermaid
flowchart LR
  Daemon["Daemon Journal"] --> Snapshot["AgentSnapshot"]
  Snapshot --> Project["projectConversation()"]
  Project --> Transcript["groupTranscript()"]
\`\`\`
`

const meta = {
  title: "Domain/Markdown & Diagrams/AgentMarkdown",
  component: AgentMarkdown,
  tags: ["autodocs"],
  args: {
    text: sampleMarkdown,
  },
} satisfies Meta<typeof AgentMarkdown>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
