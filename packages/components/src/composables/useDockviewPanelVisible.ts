import type { DockviewPanelApi } from "dockview-vue"
import { ref, watch } from "vue"

/** Dockview visibility follows both the selected tab and its group's visibility. */
export function useDockviewPanelVisible(getApi: () => DockviewPanelApi) {
  const visible = ref(false)
  watch(getApi, (api, _previous, cleanup) => {
    const update = () => { visible.value = api.isVisible && api.group.api.isVisible }
    let groupVisibility: { dispose(): void } | undefined
    const observeGroup = () => {
      groupVisibility?.dispose()
      groupVisibility = api.group.api.onDidVisibilityChange(update)
      update()
    }
    const subscription = api.onDidVisibilityChange(update)
    const groupChange = api.onDidGroupChange(observeGroup)
    observeGroup()
    cleanup(() => { subscription.dispose(); groupChange.dispose(); groupVisibility?.dispose() })
  }, { immediate: true })
  return visible
}
