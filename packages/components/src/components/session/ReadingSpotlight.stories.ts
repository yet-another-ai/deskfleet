import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { onMounted } from "vue"
import { useAppearanceStore } from "../../stores/appearance.ts"
import AgentMarkdown from "./AgentMarkdown.vue"
import ReadingSpotlight from "./ReadingSpotlight.vue"

const sampleMarkdown = `### Reading with a spotlight

When the Appearance toggle is on, move the pointer across this reply. The active line or block stays clear while the rest of the page softens, so your eye can stay on one thought at a time.

The first paragraph is longer on purpose. It spans several lines so you can see line-level highlighting inside a single block of prose while neighboring sections fade into the background.

#### Why this helps

Long agent replies mix explanations, lists, and code. Spotlighting one unit at a time reduces the visual noise without changing the words.

- Prefer short paragraphs when you can.
- Keep related bullets together.
- Leave code in its own block so the whole sample can light up.

\`\`\`ts
export function greet(name: string): string {
  return \`Hello, \${name}\`
}
\`\`\`

After the code sample, this closing paragraph should dim when you hover elsewhere, and brighten again when the pointer returns here. That contrast is the reading spotlight effect Delton asked to see.
`

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

export const Enabled: Story = {
  render: () => ({
    components: { AgentMarkdown, ReadingSpotlight },
    setup() {
      const appearance = useAppearanceStore()
      onMounted(() => {
        appearance.settings.readingSpotlight = true
        void appearance.initialize()
      })
      return { text: sampleMarkdown }
    },
    template: `
      <div class="mx-auto min-h-[80vh] w-full max-w-3xl px-6 py-4 text-[15px] leading-[1.65]">
        <AgentMarkdown :text="text" />
        <ReadingSpotlight />
      </div>
    `,
  }),
}
