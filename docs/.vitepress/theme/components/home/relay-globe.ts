import { init, use } from "echarts/core"
import { TooltipComponent } from "echarts/components"
import { CanvasRenderer } from "echarts/renderers"
import { Lines3DChart, Scatter3DChart } from "echarts-gl/charts"
import { GlobeComponent } from "echarts-gl/components"
import { anycastRelays, ownedRelays, relayConnections } from "./relay-network.ts"
import { relayPalette, relayTexture } from "./relay-globe-theme.ts"
import type { networkCopy } from "./network-locales.ts"

use([CanvasRenderer, TooltipComponent, GlobeComponent, Lines3DChart, Scatter3DChart])

type Labels = (typeof networkCopy)["en-US"]

export function createRelayGlobe(element: HTMLElement, labels: Labels, moving: boolean) {
  const chart = init(element, undefined, { devicePixelRatio: Math.min(window.devicePixelRatio, 2) })
  const palette = relayPalette(element)
  const owned = ownedRelays.map(relay => ({
    name: labels.cities[relay.city as keyof Labels["cities"]],
    coordinates: relay.coordinates,
  }))
  const points = (locations: typeof owned) => locations.map(location => ({
    name: location.name,
    value: [...location.coordinates, 0],
  }))
  const allConnections = relayConnections([...owned, ...anycastRelays])
  const ownConnections = relayConnections(owned)
  // Highlight the six arcs connecting yetanother.ai nodes.
  const globalConnections = allConnections.filter(connection =>
    !ownConnections.some(own => own.coords[0] === connection.coords[0] && own.coords[1] === connection.coords[1]))

  try {
    chart.setOption({
      backgroundColor: "transparent",
      animation: false,
      tooltip: {
        trigger: "item", triggerOn: "mousemove|click", confine: true,
        backgroundColor: palette.surface, borderColor: palette.coast,
        textStyle: { color: palette.text, fontSize: 12, fontFamily: getComputedStyle(element).fontFamily },
        formatter: "{b}<br/>{a}",
      },
      globe: {
        baseTexture: relayTexture(palette),
        globeRadius: 100,
        // All nodes sit on the surface. A nonzero altitude range would lift
        // constant-altitude scatter points and push the line endpoints inward.
        globeOuterRadius: 100,
        shading: "lambert",
        environment: "none",
        // ECharts GL derives the sun direction and seasonal tilt from this UTC instant.
        // Keep the sunlit surface below full intensity to preserve light-theme
        // coastlines, and the night-side ambient low enough to reveal the terminator.
        light: { main: { intensity: 0.85, time: Date.now() }, ambient: { intensity: 0.1 } },
        atmosphere: { show: true, color: palette.accent, offset: 3, glowPower: 9, innerGlowPower: 12 },
        viewControl: {
          distance: 255, minDistance: 255, maxDistance: 255,
          alpha: 24, beta: 200,
          autoRotate: moving, autoRotateSpeed: 5, autoRotateAfterStill: 3,
          rotateSensitivity: 1, zoomSensitivity: 0, panSensitivity: 0,
          animation: false,
        },
        temporalSuperSampling: { enable: false },
        postEffect: { enable: false },
      },
      series: [
        {
          id: "global-links", type: "lines3D", coordinateSystem: "globe",
          data: globalConnections, silent: true,
          lineStyle: { color: palette.muted, width: 0.7, opacity: 0.18 },
          effect: { show: false },
        },
        {
          id: "owned-links", type: "lines3D", coordinateSystem: "globe",
          data: ownConnections, silent: true,
          lineStyle: { color: palette.accent, width: 1.4, opacity: 0.7 },
          effect: { show: moving, period: 6, trailWidth: 2, trailLength: 0.25, trailOpacity: 0.8, trailColor: palette.accent },
        },
        {
          id: "anycast-nodes", name: labels.anycastTitle, type: "scatter3D", coordinateSystem: "globe",
          data: points(anycastRelays), symbol: "diamond", symbolSize: 8,
          itemStyle: { color: palette.muted, opacity: 1 },
          label: { show: false },
          emphasis: { label: { show: false } },
        },
        {
          id: "owned-nodes", name: labels.ownedTitle, type: "scatter3D", coordinateSystem: "globe",
          data: points(owned), symbolSize: 10,
          itemStyle: { color: palette.accent, opacity: 1, borderColor: palette.text, borderWidth: 1 },
          label: { show: false },
          emphasis: { label: { show: false } },
        },
      ],
    })
  } catch (error) {
    chart.dispose()
    throw error
  }

  return {
    resize: () => chart.resize(),
    updateLighting: () => chart.setOption({
      globe: { light: { main: { time: Date.now() } } },
    }),
    setTheme: () => {
      const next = relayPalette(element)
      chart.setOption({
        tooltip: { backgroundColor: next.surface, borderColor: next.coast, textStyle: { color: next.text } },
        globe: { baseTexture: relayTexture(next), atmosphere: { color: next.accent } },
        series: [
          { id: "global-links", lineStyle: { color: next.muted } },
          { id: "owned-links", lineStyle: { color: next.accent }, effect: { trailColor: next.accent } },
          { id: "anycast-nodes", itemStyle: { color: next.muted } },
          { id: "owned-nodes", itemStyle: { color: next.accent, borderColor: next.text } },
        ],
      })
    },
    setMotion: (enabled: boolean) => chart.setOption({
      globe: { viewControl: { autoRotate: enabled } },
      series: [{ id: "owned-links", effect: { show: enabled } }],
    }),
    setLabels: (next: Labels) => chart.setOption({
      series: [
        { id: "anycast-nodes", name: next.anycastTitle },
        { id: "owned-nodes", name: next.ownedTitle, data: points(ownedRelays.map(relay => ({
          name: next.cities[relay.city as keyof Labels["cities"]], coordinates: relay.coordinates,
        }))) },
      ],
    }),
    dispose: () => chart.dispose(),
  }
}
