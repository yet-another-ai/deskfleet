import { createRouter, createWebHashHistory } from "vue-router"

declare module "vue-router" {
  interface RouteMeta {
    /** Message key of a placeholder page's title. */
    titleKey?: string
    /** The page draws its own navigation in place of the sidebar and details panel. */
    fullWindow?: boolean
  }
}

// Hash history keeps every route on the single bundled index.html document.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      name: "new-session",
      component: () => import("../views/NewSessionView.vue"),
    },
    {
      path: "/workspaces/:workspaceId",
      name: "workspace",
      component: () => import("../views/WorkspaceView.vue"),
      props: true,
    },
    {
      path: "/worktrees/:worktreeId",
      name: "worktree",
      component: () => import("../views/WorktreeView.vue"),
      props: true,
    },
    {
      path: "/sessions/:sessionId",
      name: "session",
      component: () => import("../views/SessionView.vue"),
      props: true,
    },
    {
      path: "/machines/:machineId/terminals",
      name: "machine-terminals",
      component: () => import("../views/TerminalView.vue"),
      props: true,
    },
    {
      path: "/terminals/:terminalId",
      name: "terminal",
      component: () => import("../views/TerminalView.vue"),
      props: true,
    },
    {
      path: "/machines/:machineId/desktop",
      name: "machine-desktop",
      component: () => import("../views/DesktopView.vue"),
      props: true,
    },
    {
      path: "/settings",
      component: () => import("../views/SettingsView.vue"),
      meta: { fullWindow: true },
      children: [
        { path: "", name: "settings", redirect: { name: "settings-preferences" } },
        {
          path: "preferences",
          name: "settings-preferences",
          component: () => import("../components/settings/PreferencesSettings.vue"),
        },
        {
          path: "notifications",
          name: "settings-notifications",
          component: () => import("../components/settings/NotificationsSettings.vue"),
        },
        {
          path: "agents",
          name: "settings-agents",
          component: () => import("../components/settings/AgentsSettings.vue"),
        },
        {
          path: "team",
          name: "settings-team",
          component: () => import("../components/team/TeamSettings.vue"),
        },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
})
