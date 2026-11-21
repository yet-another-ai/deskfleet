<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, shallowRef, type HTMLAttributes } from "vue"
import { useSidebarOrder } from "../../composables/useSidebarOrder.ts"

type Edge = "before" | "after"
type DragSource = { group: string; id: string }
type SourceAttrs = HTMLAttributes & { "data-sidebar-reorder-source"?: "" }

const props = withDefaults(defineProps<{
  as?: "div" | "li"
  group: string
  id: string
  items: readonly { id: string }[]
}>(), { as: "div" })
defineSlots<{ default: (props: { source: SourceAttrs }) => unknown }>()

const { drag, move } = useSidebarOrder()
const rowSelector = "[data-sidebar-reorder-group]"
const hover = shallowRef<{ source: DragSource; edge: Edge }>()
const edge = computed(() => hover.value?.source === drag.value ? hover.value?.edge : undefined)

function isSource(source: DragSource | null): boolean {
  return source?.group === props.group && source.id === props.id
}

function startDrag(event: DragEvent): void {
  const transfer = event.dataTransfer
  if (!transfer) return
  event.stopPropagation()
  transfer.effectAllowed = "move"
  // Draggable anchors start with link data. Keep the drag local to sidebar ordering.
  transfer.clearData()
  transfer.setData("application/x-deskfleet-sidebar-order", props.id)
  const row = (event.currentTarget as HTMLElement).closest(rowSelector)
  if (row) {
    const { left, top } = row.getBoundingClientRect()
    transfer.setDragImage(row, event.clientX - left, event.clientY - top)
  }
  drag.value = { group: props.group, id: props.id }
}

function endDrag(): void {
  if (isSource(drag.value)) drag.value = null
}
onBeforeUnmount(endDrag)

function targetEdge(event: DragEvent): Edge {
  const { top, height } = (event.currentTarget as HTMLElement).getBoundingClientRect()
  return event.clientY < top + height / 2 ? "before" : "after"
}

function dragOver(event: DragEvent): void {
  const source = drag.value
  if (source?.group !== props.group || isSource(source)) return
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
  const position = targetEdge(event)
  if (hover.value?.source !== source || hover.value.edge !== position) hover.value = { source, edge: position }
}

function dragLeave(event: DragEvent): void {
  const row = event.currentTarget as HTMLElement
  if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return
  hover.value = undefined
}

function drop(event: DragEvent): void {
  const source = drag.value
  if (source?.group !== props.group || isSource(source)) return
  event.preventDefault()
  event.stopPropagation()
  move(props.group, props.items, source.id, props.id, targetEdge(event))
  drag.value = null
}

function keydown(event: KeyboardEvent): void {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
  const control = event.currentTarget as HTMLElement
  const row = control.closest<HTMLElement>(rowSelector)
  if (!row) return

  event.preventDefault()
  event.stopPropagation()
  const scope = row.closest("aside") ?? row.ownerDocument
  const rows = [...scope.querySelectorAll<HTMLElement>(rowSelector)].filter(candidate =>
    candidate.dataset.sidebarReorderGroup === props.group && !candidate.closest("[hidden]"),
  )
  const earlier = event.key === "ArrowUp"
  const sibling = rows[rows.indexOf(row) + (earlier ? -1 : 1)]
  const targetId = sibling?.dataset.sidebarReorderId
  if (targetId && move(props.group, props.items, props.id, targetId, earlier ? "before" : "after")) {
    void nextTick(() => control.focus())
  }
}

const source = computed<SourceAttrs>(() => props.items.length < 2 ? { draggable: false } : {
  draggable: true,
  "data-sidebar-reorder-source": "",
  "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
  onDragstart: startDrag,
  onDragend: endDrag,
  onKeydown: keydown,
})
</script>

<template>
  <component
    :is="as"
    class="sidebar-reorder-row relative"
    :data-sidebar-reorder-group="group"
    :data-sidebar-reorder-id="id"
    :data-sidebar-reorder-edge="edge"
    @dragover="dragOver"
    @dragleave="dragLeave"
    @drop="drop"
  >
    <slot :source="source" />
  </component>
</template>

<style scoped>
.sidebar-reorder-row[data-sidebar-reorder-edge]::after {
  content: "";
  position: absolute;
  z-index: 1;
  inset-inline: 0;
  height: 2px;
  border-radius: 1px;
  background: var(--ui-color-accent);
  pointer-events: none;
}

.sidebar-reorder-row[data-sidebar-reorder-edge="before"]::after { top: -1px; }
.sidebar-reorder-row[data-sidebar-reorder-edge="after"]::after { bottom: -1px; }
</style>
