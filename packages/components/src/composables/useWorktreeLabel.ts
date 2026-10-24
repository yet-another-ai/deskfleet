import { useI18n } from "vue-i18n"
import type { AgentSessionSummary } from "../stores/fleet-types.ts"

/** A worktree is shown within its owning session; a directory Session uses the Workspace's own paths. */
export function useWorktreeLabel() {
  const { t } = useI18n()
  return (session?: Pick<AgentSessionSummary, "context">): string => t(session?.context === "directory" ? "session.directory" : "session.worktree")
}
