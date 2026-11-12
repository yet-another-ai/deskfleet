import { createRouter, createWebHashHistory } from "vue-router"
import { client } from "@deskfleet/client/platform"

declare module "vue-router" {
  interface RouteMeta {
    /** Message key of a placeholder page's title. */
    titleKey?: string
    /** The page draws its own navigation in place of the sidebar and details panel. */
    fullWindow?: boolean
    /** The section asks for recent identity proof before changing protected data. */
    recentAuthentication?: boolean
  }
}

// Hash history keeps every route on the single bundled index.html document.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/admin",
      beforeEnter: () => client.platform === "web" ? true : "/",
      component: () => import("../views/SiteAdminView.vue"),
      meta: { fullWindow: true },
      children: [
        { path: "", name: "site-admin", redirect: { name: "site-admin-settings" } },
        {
          path: "settings",
          name: "site-admin-settings",
          component: () => import("../components/settings/SiteSettings.vue"),
        },
        {
          path: "accounts",
          name: "site-admin-accounts",
          component: () => import("../components/settings/SiteIdentitySettings.vue"),
          meta: { recentAuthentication: true },
        },
        {
          path: "turn",
          name: "site-admin-turn",
          component: () => import("../components/settings/TurnSettings.vue"),
        },
        {
          path: "cloudflare-turn",
          name: "site-admin-cloudflare-turn",
          component: () => import("../components/settings/CloudflareTurnSettings.vue"),
        },
        {
          path: "manual-grants",
          name: "site-admin-manual-grants",
          component: () => import("../components/settings/EnterpriseTeams.vue"),
          meta: { recentAuthentication: true },
        },
        {
          path: "deletion-requests",
          name: "site-admin-deletion-requests",
          component: () => import("../components/settings/SiteDeletionRequests.vue"),
          meta: { recentAuthentication: true },
        },
      ],
    },
    {
      path: "/",
      name: "new-session",
      component: () => import("../views/NewSessionView.vue"),
    },
    {
      path: "/search",
      name: "search",
      component: () => import("../views/SearchView.vue"),
    },
    {
      path: "/schedules/:scheduleId?",
      name: "schedules",
      component: () => import("../views/ScheduledTasksView.vue"),
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
          path: "worktrees",
          name: "settings-worktrees",
          component: () => import("../components/settings/WorktreeSettings.vue"),
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
          path: "github",
          name: "settings-github",
          component: () => import("../components/settings/GithubSettings.vue"),
        },
        {
          path: "permissions",
          name: "settings-permissions",
          component: () => import("../components/settings/PermissionsSettings.vue"),
        },
        {
          path: "developer",
          children: [
            {
              path: "",
              name: "settings-developer",
              component: () => import("../components/settings/DeveloperSettings.vue"),
            },
            {
              path: "nat",
              name: "settings-developer-nat",
              component: () => import("../components/settings/NatSettings.vue"),
            },
          ],
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
