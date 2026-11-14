import { watchPostEffect, type DirectiveBinding, type DirectiveModifiers, type FunctionDirective, type VaporDirective } from "vue"
import { animateSpring, type SpringAnimation } from "../services/spring.ts"

type Values = Record<string, string | number>
export interface SpringStyle { to: Values; from?: Values; duration?: number; bounce?: number }
type Channels = Map<string, { parts: string[]; animations: SpringAnimation[]; values: number[] }>
const channels = new WeakMap<HTMLElement, Channels>()
const numberPattern = /-?(?:\d*\.)?\d+(?:e[+-]?\d+)?/gi
const cssName = (name: string) => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)

/** Directives own DOM listeners explicitly across VDOM and Vapor lifecycles. */
function onReducedMotion(settle: () => void): () => void {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)")
  const changed = () => { if (media.matches) settle() }
  media.addEventListener("change", changed)
  return () => media.removeEventListener("change", changed)
}

/** Vapor supplies reactive getters; VDOM supplies a binding on each render. */
export function motionDirective<Value>(
  render: (element: HTMLElement, value: Value, modifiers: DirectiveModifiers, first: boolean) => void,
  dispose: (element: HTMLElement) => void,
): FunctionDirective<HTMLElement, Value> & VaporDirective<HTMLElement, Value> {
  const mounted = new WeakSet<HTMLElement>()
  const directive = (
    element: HTMLElement,
    valueOrBinding: (() => Value) | DirectiveBinding<Value> | undefined,
    _argument?: unknown,
    modifiers: DirectiveModifiers = {},
  ) => {
    if (typeof valueOrBinding === "object") {
      // Vue normalizes a function directive to mounted/updated hooks. Keep
      // teardown on that binding so a v-if removal also cancels its motion.
      valueOrBinding.dir.beforeUnmount = () => { dispose(element); mounted.delete(element) }
      render(element, valueOrBinding.value, valueOrBinding.modifiers, !mounted.has(element))
      mounted.add(element)
      return
    }
    let first = true
    const stop = watchPostEffect(() => {
      render(element, valueOrBinding?.() as Value, modifiers, first)
      first = false
    })
    return () => { stop(); dispose(element) }
  }
  return directive as FunctionDirective<HTMLElement, Value> & VaporDirective<HTMLElement, Value>
}

/** Animate numeric CSS values in their declared units, retaining each channel's velocity. */
function update(element: HTMLElement, binding: SpringStyle | Values, entering = false): void {
  const options = "to" in binding && typeof binding.to === "object" ? binding as SpringStyle : { to: binding as Values }
  let state = channels.get(element)
  if (!state) { state = new Map(); channels.set(element, state) }
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  for (const [name, raw] of Object.entries(options.to)) {
    const property = cssName(name)
    const value = String(raw)
    const numbers = [...value.matchAll(numberPattern)].map(match => Number(match[0]))
    const parts = value.split(numberPattern)
    let channel = state.get(property)
    if (channel && (channel.parts.join("|") !== parts.join("|") || channel.values.length !== numbers.length)) {
      channel.animations.forEach(animation => animation.cancel())
      state.delete(property)
      channel = undefined
    }
    if (!channel) {
      const from = options.from?.[name]
      const initial = from === undefined ? numbers.map(number => entering ? (property === "scale" ? 1 : 0) : number)
        : [...String(from).matchAll(numberPattern)].map(match => Number(match[0]))
      const next = { parts, values: numbers.map((number, index) => initial[index] ?? number), animations: [] as SpringAnimation[] }
      const render = () => element.style.setProperty(property, next.parts.reduce((text, part, index) => text + part + (next.values[index] ?? ""), ""))
      next.animations = numbers.map((target, index) => animateSpring(reduced ? target : next.values[index]!, target, position => {
        next.values[index] = position
        render()
      }, options))
      if (!numbers.length) element.style.setProperty(property, value)
      state.set(property, next)
    } else {
      channel.animations.forEach((animation, index) => {
        if (reduced) {
          animation.cancel()
          animation.spring.jump(numbers[index]!)
          channel.values[index] = numbers[index]!
          element.style.setProperty(property, value)
        } else animation.setTarget(numbers[index]!)
      })
    }
  }
}

const stylePreferences = new WeakMap<HTMLElement, () => void>()
export const vSpring = motionDirective<SpringStyle | Values>(
  (element, value, modifiers, first) => {
    update(element, value, modifiers.enter)
    if (first) stylePreferences.set(element, onReducedMotion(() => {
      channels.get(element)?.forEach((channel, property) => {
        channel.animations.forEach((animation, index) => {
          const target = animation.spring.target
          animation.cancel()
          animation.spring.jump(target)
          channel.values[index] = target
        })
        element.style.setProperty(property, channel.parts.reduce((text, part, index) => text + part + (channel.values[index] ?? ""), ""))
      })
    }))
  },
  element => {
    stylePreferences.get(element)?.()
    stylePreferences.delete(element)
    channels.get(element)?.forEach(channel => channel.animations.forEach(animation => animation.cancel()))
    channels.delete(element)
  },
)

const entrances = new WeakMap<HTMLElement, () => void>()
function enter(element: HTMLElement, anchored: boolean): void {
  entrances.get(element)?.()
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
  const side = element.dataset.side
  const x = side === "left" ? 4 : side === "right" ? -4 : 0
  const y = side === "top" ? 4 : side === "bottom" ? -4 : side === "left" || side === "right" || anchored ? 0 : 8
  const original = { translate: element.style.translate, scale: element.style.scale }
  const restore = () => {
    element.style.translate = original.translate
    element.style.scale = original.scale
  }
  const animation = animateSpring(1, 0, position => {
    element.style.translate = `${x * position}px ${y * position}px`
    if (anchored) element.style.scale = String(1 - 0.02 * position)
  }, { positionThreshold: 0.001, velocityThreshold: 0.005 })
  const stopPreference = onReducedMotion(() => { animation.cancel(); restore() })
  const dispose = () => { animation.cancel(); stopPreference(); restore() }
  entrances.set(element, dispose)
  void animation.finished.then(() => {
    stopPreference()
    if (entrances.get(element) === dispose) restore()
  })
}
/** Anchored overlays grow from their origin; local notices keep their small rise. */
export const vSpringEnter = motionDirective<"anchor" | undefined>(
  (element, value, _modifiers, first) => { if (first) enter(element, value === "anchor") },
  element => { entrances.get(element)?.(); entrances.delete(element) },
)

const hoverCleanup = new WeakMap<HTMLElement, () => void>()
export const vSpringHover = motionDirective<number>(
  (element, value, _modifiers, first) => {
    if (!first) return
    const motion = animateSpring(0, 0, y => { element.style.translate = `0px ${y}px` })
    const stopPreference = onReducedMotion(() => {
      motion.cancel()
      motion.spring.jump(0)
      element.style.translate = "0px 0px"
    })
    const over = () => {
      if (!element.closest(":disabled, [data-disabled], [aria-disabled=true]") && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) motion.setTarget(value)
    }
    const out = () => motion.setTarget(0)
    element.addEventListener("pointerenter", over)
    element.addEventListener("pointerleave", out)
    hoverCleanup.set(element, () => {
      motion.cancel()
      stopPreference()
      element.removeEventListener("pointerenter", over)
      element.removeEventListener("pointerleave", out)
    })
  },
  element => { hoverCleanup.get(element)?.(); hoverCleanup.delete(element) },
)
