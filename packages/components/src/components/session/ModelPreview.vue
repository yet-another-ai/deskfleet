<script lang="ts">
import { RotateCcw, ZoomIn, ZoomOut } from "@lucide/vue"
import { OrbitControls } from "@tresjs/cientos"
import { TresCanvas } from "@tresjs/core"
import { Box3, Mesh, MeshStandardMaterial, Vector3, type Object3D } from "three"
import { FBXLoader } from "three/addons/loaders/FBXLoader.js"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { OBJLoader } from "three/addons/loaders/OBJLoader.js"
import { STLLoader } from "three/addons/loaders/STLLoader.js"
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js"
import { defineComponent, inject, onBeforeUnmount, ref, shallowRef, watch, watchEffect, type PropType } from "vue"
import { useI18n } from "vue-i18n"
import { registerPreviewActionsKey, type PreviewMode } from "../../services/preview.ts"

// TresCanvas mounts its default slot through a custom VDOM renderer; keep this
// SFC on standard <script> so global features.vapor leaves its slot in VDOM mode.
export default defineComponent({
  name: "ModelPreview",
  components: { TresCanvas, OrbitControls },
  props: {
    src: { type: String, required: true },
    data: { type: Object as PropType<Uint8Array>, default: undefined },
    mimeType: { type: String, default: undefined },
    filename: { type: String, default: undefined },
    mode: { type: String as PropType<PreviewMode>, required: true },
  },
  setup(props) {
    const { t } = useI18n()
    const registerActions = inject(registerPreviewActionsKey, undefined)
    const model = shallowRef<Object3D | null>(null)
    const error = ref<string>()
    const cameraPosition = ref<[number, number, number]>([0, 1.5, 3.5])
    const controlsKey = ref(0)
    let loadVersion = 0

    function detectFormat(): string {
      const mime = props.mimeType?.toLowerCase() ?? ""
      if (mime.includes("gltf") || mime.includes("glb")) return "gltf"
      if (mime.includes("stl")) return "stl"
      if (mime.includes("obj")) return "obj"
      if (mime.includes("fbx")) return "fbx"
      if (mime.includes("3mf")) return "3mf"
      return (props.filename || props.src).split(/[?#]/)[0]?.split(".").pop()?.toLowerCase() ?? "gltf"
    }

    async function resolveBuffer(): Promise<ArrayBuffer> {
      if (props.data) return props.data.slice().buffer
      if (props.src.startsWith("data:")) {
        const comma = props.src.indexOf(",")
        const meta = props.src.slice(0, comma)
        const body = props.src.slice(comma + 1)
        if (meta.includes(";base64")) {
          const binary = atob(body)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          return bytes.buffer
        }
        return new TextEncoder().encode(decodeURIComponent(body)).buffer
      }
      return (await fetch(props.src)).arrayBuffer()
    }

    function disposeModel(root: Object3D | null): void {
      if (!root) return
      root.traverse((node: Object3D & { geometry?: { dispose?: () => void }; material?: { dispose?: () => void } | { dispose?: () => void }[] }) => {
        node.geometry?.dispose?.()
        if (Array.isArray(node.material)) node.material.forEach(m => m.dispose?.())
        else node.material?.dispose?.()
      })
    }

    const zoomIn = () => {
      const [x, y, z] = cameraPosition.value
      cameraPosition.value = [x * 0.8, y * 0.8, z * 0.8]
    }
    const zoomOut = () => {
      const [x, y, z] = cameraPosition.value
      cameraPosition.value = [x * 1.25, y * 1.25, z * 1.25]
    }
    const resetView = () => {
      cameraPosition.value = [0, 1.5, 3.5]
      controlsKey.value++
    }

    watchEffect(() => {
      registerActions?.([
        { id: "zoom-in", icon: ZoomIn, label: t("mermaid.zoomIn"), onClick: zoomIn },
        { id: "zoom-out", icon: ZoomOut, label: t("mermaid.zoomOut"), onClick: zoomOut },
        { id: "reset", icon: RotateCcw, label: t("mermaid.resetView"), onClick: resetView },
      ])
    })

    watch(() => [props.src, props.data, props.mimeType, props.filename] as const, async ([url]) => {
      const version = ++loadVersion
      disposeModel(model.value)
      model.value = null
      error.value = undefined
      if (!url && !props.data) return
      try {
        const format = detectFormat()
        const buffer = await resolveBuffer()
        let loaded: Object3D
        if (format === "stl") {
          const geometry = new STLLoader().parse(buffer)
          geometry.computeVertexNormals()
          loaded = new Mesh(geometry, new MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.45, metalness: 0.15 }))
        } else if (format === "obj") {
          loaded = new OBJLoader().parse(new TextDecoder().decode(buffer))
        } else if (format === "fbx") {
          loaded = new FBXLoader().parse(buffer, "")
        } else if (format === "3mf") {
          loaded = new ThreeMFLoader().parse(buffer)
        } else {
          loaded = (await new GLTFLoader().parseAsync(buffer, "")).scene
        }
        if (version !== loadVersion) {
          disposeModel(loaded)
          return
        }
        const box = new Box3().setFromObject(loaded)
        const size = box.getSize(new Vector3())
        const center = box.getCenter(new Vector3())
        const scale = 2 / (Math.max(size.x, size.y, size.z) || 1)
        loaded.position.sub(center.multiplyScalar(scale))
        loaded.scale.setScalar(scale)
        model.value = loaded
      } catch (reason) {
        if (version === loadVersion) error.value = reason instanceof Error ? reason.message : String(reason)
      }
    }, { immediate: true })

    onBeforeUnmount(() => {
      ++loadVersion
      registerActions?.([])
      disposeModel(model.value)
    })

    return { model, error, cameraPosition, controlsKey }
  },
})
</script>

<template>
  <div
    data-preview-canvas
    class="relative flex w-full items-center justify-center overflow-hidden"
    :class="mode === 'inline' ? 'h-80 min-h-80' : 'min-h-64 flex-1 h-full'"
  >
    <p v-if="error" class="p-4 text-sm text-ui-danger" role="alert">{{ error }}</p>
    <div v-else data-preview-stage class="absolute inset-0 h-full w-full">
      <TresCanvas clear-color="#18181b" class="h-full w-full">
        <TresPerspectiveCamera :position="cameraPosition" :look-at="[0, 0, 0]" />
        <OrbitControls :key="controlsKey" make-default enable-damping />
        <TresAmbientLight :intensity="1.2" />
        <TresDirectionalLight :position="[5, 8, 5]" :intensity="1.5" />
        <TresDirectionalLight :position="[-5, -4, -5]" :intensity="0.5" />
        <TresGridHelper :args="[10, 10, '#3f3f46', '#27272a']" :position="[0, -1, 0]" />
        <primitive v-if="model" :object="model" />
      </TresCanvas>
    </div>
  </div>
</template>
