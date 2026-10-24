import { useI18n } from "vue-i18n"
import type { AgentSessionSummary } from "../stores/fleet-types.ts"

export function useSessionLabel() {
  const { t } = useI18n()
  return (session: Pick<AgentSessionSummary, "id" | "title">): string => session.title || t("session.label", { id: session.id })
}
