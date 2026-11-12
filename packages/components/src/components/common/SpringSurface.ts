import { defineComponent, h, markRaw, withDirectives } from "vue"
import { vSpringEnter } from "../../directives/spring.ts"

/** Keep Reka's surface attributes and refs on a VDOM root across Vapor slots. */
export default markRaw(defineComponent({
  name: "SpringSurface",
  inheritAttrs: false,
  setup(_props, { attrs, slots }) {
    return () => withDirectives(h("div", attrs, slots.default?.()), [[vSpringEnter]])
  },
}))
