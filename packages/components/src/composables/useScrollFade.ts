import { useEventListener, useMutationObserver, useResizeObserver } from "@vueuse/core"
import { computed, ref, toValue, watch, type CSSProperties, type MaybeRefOrGetter } from "vue"

export type ScrollFadeMode = boolean | "y" | "x" | "both" | "top"
export type ScrollFadeSize = "sm" | "md"

export interface UseScrollFadeOptions {
  fade?: MaybeRefOrGetter<ScrollFadeMode | undefined>
  size?: MaybeRefOrGetter<ScrollFadeSize | undefined>
}

const EPSILON = 1

export function useScrollFade(
  target: MaybeRefOrGetter<HTMLElement | null | undefined>,
  options: UseScrollFadeOptions = {},
) {
  const top = ref(false)
  const bottom = ref(false)
  const left = ref(false)
  const right = ref(false)

  function measure() {
    const el = toValue(target)
    const mode = toValue(options.fade) ?? "y"
    if (!el || mode === false) {
      top.value = false
      bottom.value = false
      left.value = false
      right.value = false
      return
    }

    const enableTop = mode === true || mode === "y" || mode === "both" || mode === "top"
    const enableBottom = mode === true || mode === "y" || mode === "both"
    const enableX = mode === "x" || mode === "both"

    const overflowY = el.scrollHeight - el.clientHeight > EPSILON
    const overflowX = el.scrollWidth - el.clientWidth > EPSILON

    top.value = enableTop && overflowY && el.scrollTop > EPSILON
    bottom.value = enableBottom && overflowY && el.scrollTop + el.clientHeight < el.scrollHeight - EPSILON
    left.value = enableX && overflowX && el.scrollLeft > EPSILON
    right.value = enableX && overflowX && el.scrollLeft + el.clientWidth < el.scrollWidth - EPSILON
  }

  useEventListener(target, "scroll", measure, { passive: true })
  useResizeObserver(target, measure)
  useResizeObserver(
    () => {
      const content = toValue(target)?.firstElementChild
      return content instanceof HTMLElement ? content : null
    },
    measure,
  )
  useMutationObserver(target, measure, { childList: true, subtree: true, characterData: true })
  watch([() => toValue(target), () => toValue(options.fade)], measure, { immediate: true, flush: "post" })

  const fadeStyle = computed<CSSProperties>(() => {
    const px = (toValue(options.size) ?? "md") === "sm" ? "16px" : "24px"
    return {
      "--ui-scroll-fade-top": top.value ? px : "0px",
      "--ui-scroll-fade-bottom": bottom.value ? px : "0px",
      "--ui-scroll-fade-left": left.value ? px : "0px",
      "--ui-scroll-fade-right": right.value ? px : "0px",
    }
  })

  return { fadeStyle, measure, top, bottom, left, right }
}
