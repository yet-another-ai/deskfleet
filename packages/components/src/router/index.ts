import { createRouter, createWebHashHistory } from "vue-router"
import { client } from "@deskfleet/client/platform"

declare module "vue-router" {
  interface RouteMeta {
    /** Message key of a placeholder page's title. */
    titleKey?: string
    /** The page draws its own navigation in place of the sidebar and details panel. */
    fullWindow?: boolean
    /** Management pages have no selected resource for the details panel. */
    hideDetails?: boolean
  }
}

// Hash history keeps every route on the single bundled index.html document.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/admin",
      name: "site-admin",
      beforeEnter: () => client.platform === "web" ? true : "/",
      component: () => import("../views/SiteAdminView.vue"),
      meta: { fullWindow: true },
    },
    {
      path: "/",
      name: "new-session",
      component: () => import("../views/NewSessionView.vue"),
    },
    {
      path: "/schedules/:scheduleId?",
      name: "schedules",
      component: () => import("../views/ScheduledTasksView.vue"),
      props: true,
      meta: { hideDetails: true },
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
      path: "/sessions/archived",
      name: "archived-sessions",
      component: () => import("../views/ArchivedSessionsView.vue"),
      meta: { hideDetails: true },
    },
    {
      path: "/sessions/:sessionId",
      name: "session",
      component: () => import("../views/SessionView.vue"),
      props: true,
    },
    {
      path: "/machines/:machineId/control",
      name: "machine-control",
      component: () => import("../views/RemoteControlView.vue"),
      props: true,
    },
    {
      path: "/machines/:machineId/terminals",
      name: "machine-terminals",
      redirect: to => ({ name: "machine-control", params: { machineId: to.params.machineId }, query: { tab: "terminal" } }),
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
      redirect: to => ({ name: "machine-control", params: { machineId: to.params.machineId }, query: { tab: "desktop" } }),
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
          path: "appearance",
          name: "settings-appearance",
          component: () => import("../components/settings/AppearanceSettings.vue"),
        },
        {
          path: "notifications",
          name: "settings-notifications",
          component: () => import("../components/settings/NotificationsSettings.vue"),
        },
        {
          path: "permissions",
          name: "settings-permissions",
          component: () => import("../components/settings/PermissionsSettings.vue"),
        },
        {
          path: "about",
          name: "settings-about",
          component: () => import("../components/settings/AboutSettings.vue"),
        },
        {
          path: "agents",
          name: "settings-agents",
          component: () => import("../components/settings/AgentsSettings.vue"),
        },
        {
          path: "mcp-servers",
          name: "settings-mcp-servers",
          component: () => import("../components/settings/McpServersSettings.vue"),
        },
      ],
    },
    {
      path: "/team/settings",
      component: () => import("../views/TeamSettingsView.vue"),
      meta: { fullWindow: true },
      children: [
        {
          path: "",
          name: "team-settings",
          component: () => import("../components/team/TeamSettings.vue"),
        },
        {
          path: "plans",
          name: "team-settings-plans",
          component: () => import("../components/settings/PlansUsageSettings.vue"),
        },
        {
          path: "ai-usage",
          name: "team-settings-ai-usage",
          component: () => import("../components/settings/AiUsageSettings.vue"),
        },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
})
