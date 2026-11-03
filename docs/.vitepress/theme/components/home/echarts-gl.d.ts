// ECharts GL ships JavaScript extensions without TypeScript declarations.
declare module "echarts-gl/charts" {
  export const Lines3DChart: import("echarts/core").EChartsExtensionInstaller
  export const Scatter3DChart: import("echarts/core").EChartsExtensionInstaller
}

declare module "echarts-gl/components" {
  export const GlobeComponent: import("echarts/core").EChartsExtensionInstaller
}
