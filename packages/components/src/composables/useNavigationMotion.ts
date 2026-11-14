import { createInjectionState } from "@vueuse/core"
import { readonly, shallowRef, watch } from "vue"
import { useRoute } from "vue-router"
import { navigationKey, resolveNavigationMotion, type NavigationTransition } from "../services/navigation-motion.ts"

function createNavigationMotion() {
  const route = useRoute()
  // useRoute is one reactive proxy across navigations. Retain the previous
  // identity's values so classification never compares the proxy with itself.
  const snapshot = () => ({ name: route.name, path: route.path, params: { ...route.params } })
  let previous = snapshot()
  const transition = shallowRef<NavigationTransition>({ key: navigationKey(previous), motion: "peer" })
  watch(() => route.fullPath, () => {
    const next = snapshot()
    const key = navigationKey(next)
    if (key === transition.value.key) return
    transition.value = { key, motion: resolveNavigationMotion(next, previous) }
    previous = next
  }, { flush: "sync" })
  return readonly(transition)
}

const [provideNavigationMotion, injectNavigationMotion] = createInjectionState(createNavigationMotion)

/** An App owns its navigation history; a new Machine scope starts without a direction. */
export { provideNavigationMotion }

/** Standalone settings shells own the same state when no Machine App provides it. */
export function useNavigationMotion() {
  return injectNavigationMotion() ?? createNavigationMotion()
}
