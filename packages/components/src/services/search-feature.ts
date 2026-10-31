import { useFeatureGate } from "./analytics.ts"

export const SEARCH_FEATURE_GATE = "global_search"

/** Search stays unavailable without Statsig or while its current identity is loading. */
export function useSearchFeature() { return useFeatureGate(SEARCH_FEATURE_GATE) }
