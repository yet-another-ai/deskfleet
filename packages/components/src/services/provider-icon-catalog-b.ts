import { iconsFrom } from "./provider-icon-marks.ts"

const marks = import.meta.glob<string>([
  "../../node_modules/@lobehub/icons-static-svg/icons/[h-zH-Z0-9]*.svg",
  "!../../node_modules/@lobehub/icons-static-svg/icons/*-*.svg",
], { eager: true, query: "?raw", import: "default" })

export const providerIcons = iconsFrom(marks)
