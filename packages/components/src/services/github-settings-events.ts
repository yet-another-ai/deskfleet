import type { EventBusKey } from "@vueuse/core"
import type { CentralApi, GithubAppSettings } from "@deskfleet/client/central"

export const githubSettingsChanged: EventBusKey<{ central: CentralApi; settings: GithubAppSettings }> = Symbol("github-settings-changed")
