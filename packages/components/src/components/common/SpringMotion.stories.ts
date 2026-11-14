import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { defineComponent, ref } from "vue"
import { useSpring } from "../../composables/useSpring.ts"
import SpringMotion from "./SpringMotion.vue"
import UiButton from "./UiButton.vue"

const meta = {
  title: "Foundational/Motion/SpringMotion",
  component: SpringMotion,
  tags: ["autodocs"],
  argTypes: {
    duration: { control: { type: "range", min: 0.1, max: 1.5, step: 0.05 }, description: "Perceived duration in seconds. Changing this control resets the example." },
    bounce: { control: { type: "range", min: 0, max: 0.9, step: 0.01 }, description: "Overshoot amount. Zero is critically damped." },
    initial: { table: { disable: true } },
    target: { table: { disable: true } },
  },
  args: { initial: 0, target: 0, duration: 0.5, bounce: 0.16 },
  parameters: { controls: { include: ["duration", "bounce"] } },
} satisfies Meta<typeof SpringMotion>

export default meta
type Story = StoryObj<typeof meta>

export const RedirectAndDrag: Story = {
  render: args => ({
    components: { SpringMotion, UiButton },
    setup() {
      const motion = ref<InstanceType<typeof SpringMotion> | null>(null)
      const target = ref(0)
      const dragging = ref(false)
      let pointer: { id: number; x: number; position: number } | undefined
      function start(event: PointerEvent) {
        if (event.button !== 0 || pointer || !motion.value) return
        pointer = { id: event.pointerId, x: event.clientX, position: motion.value.position }
        dragging.value = true
        motion.value.startDrag(event.timeStamp / 1000)
        ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
      }
      function move(event: PointerEvent) {
        if (pointer?.id !== event.pointerId) return
        motion.value?.dragTo(pointer.position + event.clientX - pointer.x, event.timeStamp / 1000)
      }
      function end(event: PointerEvent) {
        if (pointer?.id !== event.pointerId) return
        pointer = undefined
        dragging.value = false
        motion.value?.endDrag(event.timeStamp / 1000, "spring")
      }
      return { args, motion, target, dragging, start, move, end }
    },
    template: `
      <section class="w-[25rem] max-w-full space-y-4">
        <div>
          <h2 class="m-0 text-base font-semibold">Redirect or catch a moving spring</h2>
          <p class="mb-0 mt-2 text-sm text-ui-text-muted">Switch targets rapidly, or drag the dot and release it. Position and velocity continue through each interruption.</p>
        </div>
        <div class="flex gap-2">
          <UiButton v-for="point in [0, 144, 288]" :key="point" :variant="target === point ? 'primary' : 'default'" :aria-pressed="target === point" @click="target = point">
            {{ point === 0 ? 'Left' : point === 144 ? 'Center' : 'Right' }}
          </UiButton>
        </div>
        <SpringMotion ref="motion" :key="args.duration + ':' + args.bounce" :initial="0" :target="target" :duration="args.duration" :bounce="args.bounce" v-slot="{ position, velocity, active }">
          <div class="relative h-36 overflow-hidden rounded-xl border border-ui-border bg-ui-surface">
            <div class="absolute left-8 top-18 h-px w-72 bg-ui-border" />
            <span class="absolute left-8 top-7 h-22 border-l border-dashed border-ui-accent/50" :style="{ transform: 'translateX(' + target + 'px)' }" />
            <button
              type="button" aria-label="Drag spring position" class="absolute left-4 top-14 h-8 w-8 touch-none rounded-full bg-ui-accent shadow-ui-card outline-none focus-visible:ring-2 focus-visible:ring-ui-focus"
              :class="dragging ? 'cursor-grabbing' : 'cursor-grab'" :style="{ transform: 'translateX(' + position + 'px)' }"
              @pointerdown="start" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end"
              @keydown.left.prevent="target = 0" @keydown.right.prevent="target = 288"
            />
          </div>
          <dl class="m-0 flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs text-ui-text-muted">
            <div><dt class="inline">Position </dt><dd class="m-0 inline">{{ position.toFixed(1) }} px</dd></div>
            <div><dt class="inline">Velocity </dt><dd class="m-0 inline">{{ velocity.toFixed(1) }} px/s</dd></div>
            <div><dt class="sr-only">State</dt><dd class="m-0">{{ dragging ? 'Dragging' : active ? 'Moving' : 'At rest' }}</dd></div>
          </dl>
        </SpringMotion>
      </section>
    `,
  }),
}

const InertiaCanvas = defineComponent({
  components: { UiButton },
  props: { duration: { type: Number, default: 0.5 } },
  setup(props) {
    const x = useSpring(0, { duration: props.duration, bounce: 0 })
    const y = useSpring(0, { duration: props.duration, bounce: 0 })
    let pointer: { id: number; x: number; y: number; originX: number; originY: number } | undefined
    function start(event: PointerEvent) {
      if (event.button !== 0 || pointer) return
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: x.position.value, originY: y.position.value }
      x.startDrag(event.timeStamp / 1000)
      y.startDrag(event.timeStamp / 1000)
      ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    }
    function move(event: PointerEvent) {
      if (pointer?.id !== event.pointerId) return
      x.dragTo(pointer.originX + event.clientX - pointer.x, event.timeStamp / 1000)
      y.dragTo(pointer.originY + event.clientY - pointer.y, event.timeStamp / 1000)
    }
    function end(event: PointerEvent) {
      if (pointer?.id !== event.pointerId) return
      pointer = undefined
      x.endDrag(event.timeStamp / 1000, "inertia")
      y.endDrag(event.timeStamp / 1000, "inertia")
    }
    function center() { x.setTarget(0); y.setTarget(0) }
    return { x: x.position, y: y.position, velocityX: x.velocity, velocityY: y.velocity, dragging: x.isDragging, activeX: x.isActive, activeY: y.isActive, start, move, end, center }
  },
  template: `
    <section class="w-[30rem] max-w-full space-y-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 class="m-0 text-base font-semibold">Drag a canvas, then let it coast</h2>
          <p class="mb-0 mt-2 text-sm text-ui-text-muted">Release while moving to keep momentum. Catch the canvas to interrupt it; pause before releasing to stop in place.</p>
        </div>
        <UiButton @click="center">Center</UiButton>
      </div>
      <div
        class="relative h-64 touch-none overflow-hidden rounded-xl border border-ui-border bg-ui-surface select-none"
        :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
        :style="{ backgroundImage: 'radial-gradient(circle, var(--ui-color-border) 1px, transparent 1px)', backgroundSize: '24px 24px', backgroundPosition: x + 'px ' + y + 'px' }"
        @pointerdown="start" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end"
      >
        <div class="pointer-events-none absolute left-1/2 top-1/2 flex h-20 w-32 items-center justify-center rounded-xl border border-ui-border bg-ui-canvas text-sm font-medium shadow-ui-card" :style="{ transform: 'translate(calc(-50% + ' + x + 'px), calc(-50% + ' + y + 'px))' }">Canvas origin</div>
      </div>
      <p class="m-0 font-mono text-xs text-ui-text-muted">x {{ x.toFixed(1) }} · y {{ y.toFixed(1) }} px · speed {{ Math.hypot(velocityX, velocityY).toFixed(1) }} px/s · {{ dragging ? 'Dragging' : activeX || activeY ? 'Coasting' : 'At rest' }}</p>
    </section>
  `,
})

export const InertialCanvas: Story = {
  args: { bounce: 0 },
  parameters: { controls: { include: ["duration"] } },
  render: args => ({
    components: { InertiaCanvas },
    setup: () => ({ args }),
    template: `<InertiaCanvas :key="args.duration" :duration="args.duration" />`,
  }),
}
