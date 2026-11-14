import type { NavigationTransition } from "../services/navigation-motion.ts"
import { animateSpring, type SpringAnimation } from "../services/spring.ts"
import { motionDirective } from "./spring.ts"

interface Entrance {
  key: string
  animation?: SpringAnimation
  dispose(): void
}
const entrances = new WeakMap<HTMLElement, Entrance>()

/** The identity controls motion only; it never changes the component's Vue key. */
export const vNavigationMotion = motionDirective<NavigationTransition | undefined>(
  (element, transition) => {
    const previous = entrances.get(element)
    if (!transition || previous?.key === transition.key) return
    previous?.dispose()
    const preferred = window.matchMedia("(prefers-reduced-motion: reduce)")
    const original = { opacity: element.style.opacity, translate: element.style.translate }
    const restore = () => {
      element.style.opacity = original.opacity
      element.style.translate = original.translate
    }
    const settle = () => {
      if (!preferred.matches) return
      entrance.animation?.cancel()
      restore()
    }
    const entrance: Entrance = {
      key: transition.key,
      dispose() {
        entrance.animation?.cancel()
        preferred.removeEventListener("change", settle)
        restore()
      },
    }
    entrances.set(element, entrance)
    if (transition.motion === "none" || preferred.matches) return
    const x = transition.motion === "enter" ? 16 : transition.motion === "return" ? -16 : 0
    preferred.addEventListener("change", settle)
    entrance.animation = animateSpring(1, 0, position => {
      element.style.opacity = String(Math.max(0, Math.min(1, 1 - position)))
      if (x) element.style.translate = `${x * position}px 0px`
    }, { positionThreshold: 0.001, velocityThreshold: 0.005 })
    void entrance.animation.finished.then(() => {
      if (entrances.get(element) !== entrance) return
      preferred.removeEventListener("change", settle)
      restore()
    })
  },
  element => { entrances.get(element)?.dispose(); entrances.delete(element) },
)
