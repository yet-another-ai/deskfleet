import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { onMounted } from "vue"
import type { ReadingSpotlightStyle } from "@deskfleet/client/appearance"
import { useAppearanceStore } from "../../stores/appearance.ts"
import AgentMarkdown from "./AgentMarkdown.vue"
import ReadingSpotlight from "./ReadingSpotlight.vue"

const sampleMarkdown = `### Reading with a spotlight

When the Appearance toggle is on, move the pointer across this reply. The highlight box follows the active line or block — the rest of the page stays at normal brightness, matching Nólëbase Spotlight.

This longer paragraph spans several lines on purpose. Hover within it to see line-level highlighting; neighboring headings, lists, and code keep their usual contrast.

#### Why this helps

Long agent replies mix explanations, lists, and code. Marking one unit at a time keeps focus without dimming the transcript.

- Prefer short paragraphs when you can.
- Keep related bullets together.
- Leave code in its own block so the whole sample can light up.

\`\`\`ts
export function greet(name: string): string {
  return \`Hello, \${name}\`
}
\`\`\`

After the code sample, this closing paragraph should pick up the highlight when the pointer returns here.
`

function enableSpotlight(style: ReadingSpotlightStyle): void {
  const appearance = useAppearanceStore()
  appearance.settings.readingSpotlight = true
  appearance.settings.readingSpotlightStyle = style
  void appearance.initialize()
}

function renderStyle(style: ReadingSpotlightStyle) {
  return {
    components: { AgentMarkdown, ReadingSpotlight },
    setup() {
      onMounted(() => enableSpotlight(style))
      return { text: sampleMarkdown }
    },
    template: `
      <div class="mx-auto min-h-[80vh] w-full max-w-3xl px-10 py-6 text-[15px] leading-[1.65]">
        <AgentMarkdown :text="text" />
        <ReadingSpotlight />
      </div>
    `,
  }
}

const meta = {
  title: "Domain/Agent Session/ReadingSpotlight",
  component: ReadingSpotlight,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof ReadingSpotlight>

export default meta
type Story = StoryObj<typeof meta>

/** Default style — matches Nólëbase `SpotlightStyle.Aside`. */
export const Aside: Story = {
  render: () => renderStyle("aside"),
}

/** Soft wash under the active line/block — Nólëbase `SpotlightStyle.Under`. */
export const Under: Story = {
  render: () => renderStyle("under"),
}
