import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AccountAuthentication, CaptchaAction } from "@deskfleet/client/account-security"
import { HttpError } from "@deskfleet/client/http-central"

async function solveChallenge(challenge: unknown): Promise<string | undefined> {
  await import("altcha")
  const widget = document.createElement("altcha-widget")
  // The app handles status and submission for both forms and OAuth buttons.
  widget.hidden = true
  widget.setAttribute("configuration", JSON.stringify({
    auto: "off",
    display: "invisible",
    challenge,
    humanInteractionSignature: false,
  }))
  const ready = new Promise<void>(resolve => widget.addEventListener("load", () => resolve(), { once: true }))
  document.body.append(widget)
  try {
    await ready
    return (await widget.verify({ minDuration: 0 }))?.payload
  } finally {
    widget.remove()
  }
}

export function useAuthCaptcha(account: AccountAuthentication, enabled: () => boolean) {
  const { t } = useI18n()
  const required = ref(enabled())
  const checking = ref(false)
  watch(enabled, value => { required.value = value })

  async function proof(action: CaptchaAction): Promise<string | undefined> {
    if (!required.value) return
    checking.value = true
    try {
      const challenge = await account.captchaChallenge(action)
      if (challenge === undefined) {
        // The site administrator disabled verification since this page loaded.
        required.value = false
        return
      }
      const payload = await solveChallenge(challenge).catch(() => undefined)
      if (!payload) throw new Error(t("auth.captchaRetry"))
      return payload
    } finally {
      checking.value = false
    }
  }

  function failure(reason: unknown): string | undefined {
    if (reason instanceof HttpError && (reason.code === "captcha_required" || reason.code === "captcha_invalid")) {
      required.value = true
      return t("auth.captchaRetry")
    }
  }

  return { required, checking, proof, failure }
}
