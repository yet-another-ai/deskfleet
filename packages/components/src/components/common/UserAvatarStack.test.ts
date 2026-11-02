import { mount } from "@vue/test-utils"
import { expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import type { SessionFace } from "../../services/session-faces.ts"
import UserAvatarStack from "./UserAvatarStack.vue"

vi.mock("../../services/gravatar.ts", () => ({
  loadGravatar: async () => undefined,
  avatarInitials: (name: string) => name.charAt(0).toUpperCase(),
}))

const people: SessionFace[] = [
  { id: "ada", name: "Ada", email: "ada@example.test", active: true },
  { id: "grace", name: "Grace", email: null, active: false },
]

test("people who are here stay opaque and in front of people who only visited", () => {
  const view = mount(UserAvatarStack, { props: { people, size: 24 }, global: { plugins: [i18n] } })
  const faces = view.findAll("[data-active]")
  expect(faces.map(face => face.attributes("data-active"))).toEqual(["true", "false"])
  expect(faces[0]!.classes()).not.toContain("op-45")
  expect(faces[1]!.classes()).toContain("op-45")
  expect(faces[0]!.attributes("title")).toBe("Ada is viewing")
  expect(faces[1]!.attributes("title")).toBe("Grace viewed this session")
  expect(view.find("img").exists()).toBe(false)
  expect(faces[1]!.text()).toBe("G")
})

test("extra people collapse into a count that keeps the same placeholder", () => {
  const crowd = [...people, { id: "alan", name: "Alan", email: null, active: false }]
  const view = mount(UserAvatarStack, { props: { people: crowd, size: 16, limit: 2 }, global: { plugins: [i18n] } })
  expect(view.findAll("[data-active]")).toHaveLength(1)
  expect(view.text()).toContain("+2")
  expect(view.get("span.rounded-full:last-child").attributes("title")).toBe("2 more")
})
