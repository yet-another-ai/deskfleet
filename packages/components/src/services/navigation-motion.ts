import type { RouteLocationResolvedGeneric } from "vue-router"

export type NavigationMotion = "none" | "peer" | "enter" | "return"
export interface NavigationTransition { key: string; motion: NavigationMotion }
type NavigationLocation = Pick<RouteLocationResolvedGeneric, "name" | "path" | "params">

/** Animation identity is independent of Vue's component key and URL view state. */
export function navigationKey(route: NavigationLocation): string {
  return JSON.stringify([
    route.name == null ? route.path : String(route.name),
    Object.keys(route.params).sort().map(name => [name, route.params[name]]),
  ])
}

/** Direction describes the visible page relationship, regardless of push/replace/history. */
export function resolveNavigationMotion(to: NavigationLocation, from: NavigationLocation): NavigationMotion {
  if (navigationKey(to) === navigationKey(from)) return "none"
  if (from.name === "settings-developer" && to.name === "settings-developer-nat") return "enter"
  if (from.name === "settings-developer-nat" && to.name === "settings-developer") return "return"
  if (from.name === "schedules" && to.name === "schedules") {
    const fromDetail = !!from.params.scheduleId
    const toDetail = !!to.params.scheduleId
    if (!fromDetail && toDetail) return "enter"
    if (fromDetail && !toDetail) return "return"
  }
  return "peer"
}
