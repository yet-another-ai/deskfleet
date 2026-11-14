import { defineComponent, h, markRaw, withDirectives, type PropType } from "vue"
import { vSpringEnter } from "../../directives/spring.ts"

/** Keep Reka's surface attributes and refs on a VDOM root across Vapor slots. */
export default markRaw(defineComponent({
  name: "SpringSurface",
  inheritAttrs: false,
  props: { motion: { type: String as PropType<"anchor" | "none">, default: "anchor" } },
  setup(props, { attrs, slots }) {
    return () => {
      const surface = h("div", attrs, slots.default?.())
      return props.motion === "none" ? surface : withDirectives(surface, [[vSpringEnter, "anchor"]])
    }
  },
}))
