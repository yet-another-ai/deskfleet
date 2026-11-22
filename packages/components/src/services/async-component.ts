import { defineAsyncComponent, defineComponent, h, inject, provide, ref, type AsyncComponentLoader, type Component, type InjectionKey } from "vue"
import AsyncLoadError from "../components/common/AsyncLoadError.vue"
import { isDynamicImportError, recoverFromModuleImportError, type ModuleRecoveryEnvironment } from "./module-recovery.ts"

export interface AsyncLoadErrorActions {
  canRetry: boolean
  retry(): void
  reload(): void
}

export const asyncLoadErrorActionsKey: InjectionKey<AsyncLoadErrorActions> = Symbol("deskfleet:async-load-error-actions")

export function useAsyncLoadErrorActions(): AsyncLoadErrorActions | undefined {
  return inject(asyncLoadErrorActionsKey, undefined)
}

export interface RecoverableAsyncComponentOptions {
  /** Automatically attempt a guarded page reload on stale dynamic import errors. */
  allowReload?: () => boolean
  /** Custom recovery environment (for tests). */
  env?: ModuleRecoveryEnvironment
}

export function defineRecoverableAsyncComponent<T extends Component = Component>(
  loader: AsyncComponentLoader<T>,
  options: RecoverableAsyncComponentOptions = {},
): Component {
  return defineComponent({
    name: "RecoverableAsyncComponent",
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      const attempt = ref(0)
      const importFailed = ref(false)
      const Inner = defineAsyncComponent({
        loader,
        errorComponent: AsyncLoadError,
        onError(error, _retry, fail) {
          // Browsers negatively cache failed ES module specifiers for the lifetime of the
          // document, so retrying the same import() in place cannot fetch updated chunks.
          if (isDynamicImportError(error)) {
            importFailed.value = true
            const reloadAllowed = options.allowReload ? options.allowReload() : true
            if (reloadAllowed && recoverFromModuleImportError(undefined, options.env)) {
              return
            }
          } else {
            importFailed.value = false
          }
          fail()
        },
      })
      provide(asyncLoadErrorActionsKey, {
        get canRetry() { return !importFailed.value },
        retry: () => { attempt.value += 1 },
        reload: () => {
          const reload = options.env?.reload ?? (typeof window !== "undefined" ? () => window.location.reload() : undefined)
          reload?.()
        },
      })
      return () => h(Inner, { ...attrs, key: attempt.value }, slots)
    },
  })
}
