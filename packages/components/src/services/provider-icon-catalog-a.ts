import { iconsFrom } from "./provider-icon-marks.ts"

const marks = import.meta.glob<string>([
  "../../node_modules/@lobehub/icons-static-svg/icons/[a-gA-G]*.svg",
  "!../../node_modules/@lobehub/icons-static-svg/icons/*-*.svg",
], { eager: true, query: "?raw", import: "default" })

export const providerIcons = iconsFrom(marks)
