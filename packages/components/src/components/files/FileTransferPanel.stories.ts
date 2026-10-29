import type { Meta, StoryObj } from "@storybook/vue3-vite"
import type { FilesApi, FileTransfer } from "../../../../client/src/files.ts"
import { createStorybookDesktopApi, storybookFileTransfers } from "../../../.storybook/storybook-fixtures.ts"
import FileTransferPanel from "./FileTransferPanel.vue"

const defaultApi: FilesApi = createStorybookDesktopApi().files!

const emptyQueueApi: FilesApi = {
  ...defaultApi,
  transfers: async () => [],
}

const failedTransfers: FileTransfer[] = [
  ...storybookFileTransfers,
  {
    id: "tr-4",
    name: "database-dump.sql",
    kind: "file",
    source: { target: { kind: "local" }, path: "/Users/ada/Backups/database-dump.sql" },
    destination: {
      target: { kind: "machine", machineId: "machine-1", teamId: "team-1" },
      path: "/workspace/deskfleet/database-dump.sql",
    },
    state: "failed",
    transferredBytes: 4_194_304,
    totalBytes: 67_108_864,
    bytesPerSecond: 0,
    error: "Remote disk quota exceeded while writing /workspace/deskfleet/database-dump.sql",
  },
  {
    id: "tr-5",
    name: "node_modules",
    kind: "directory",
    source: {
      target: { kind: "machine", machineId: "machine-1", teamId: "team-1" },
      path: "/workspace/deskfleet/node_modules",
    },
    destination: { target: { kind: "local" }, path: "/Users/ada/Downloads/node_modules" },
    state: "cancelled",
    transferredBytes: 1_048_576,
    totalBytes: 104_857_600,
    bytesPerSecond: 0,
  },
]

const failedQueueApi: FilesApi = {
  ...defaultApi,
  transfers: async () => structuredClone(failedTransfers),
}

const meta = {
  title: "Domain/Git & File Transfer/FileTransferPanel",
  component: FileTransferPanel,
  tags: ["autodocs"],
  args: {
    api: defaultApi,
    target: { kind: "machine", machineId: "machine-1", teamId: "team-1" },
    machineName: "MacBook Pro (Studio)",
  },
} satisfies Meta<typeof FileTransferPanel>

export default meta
type Story = StoryObj<typeof meta>

export const WithActiveQueue: Story = {}

export const EmptyQueue: Story = {
  args: {
    api: emptyQueueApi,
  },
}

export const WithFailedAndCancelledTransfers: Story = {
  args: {
    api: failedQueueApi,
    machineName: "Linux Build Server",
  },
}
