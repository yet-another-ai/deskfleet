import { client } from "@deskfleet/client/platform"
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi, CentralEvent } from "../../../../client/src/central.ts"
import type { FileListing, FilesApi, FileTransfer } from "../../../../client/src/files.ts"
import { i18n } from "../../i18n/index.ts"
import FileTransferPanel from "./FileTransferPanel.vue"

let wrapper: VueWrapper | undefined
const target = { kind: "machine", machineId: "22", teamId: "3" } as const
const local: FileListing = { grantId: "local-files", path: "/Users/me", parentPath: "/Users", homePath: "/Users/me", roots: [], entries: [{ name: "assets", path: "/Users/me/assets", kind: "directory", size: 0, modifiedAt: 1 }] }
const remote: FileListing = { path: "D:\\output", parentPath: "D:\\", homePath: "D:\\", roots: [], entries: [] }
const task: FileTransfer = { id: "transfer-1", name: "assets", kind: "directory", source: { target: { kind: "local", grantId: "local-files" }, path: "/Users/me/assets" }, destination: { target, path: remote.path }, state: "transferring", transferredBytes: 32, totalBytes: 64, bytesPerSecond: 16 }
function setup(overrides: Partial<FilesApi> = {}) {
  let update!: (transfers: FileTransfer[]) => void
  const unsubscribe = vi.fn()
  const api: FilesApi = {
    list: vi.fn(async value => value.kind === "local" ? local : remote),
    chooseLocalDirectory: vi.fn(async () => local), enqueue: vi.fn(async () => "new-transfer"),
    transfers: vi.fn(async () => [task]), cancel: vi.fn(async () => {}), retry: vi.fn(async () => {}),
    onChanged: listener => { update = listener; return unsubscribe },
    resolveResource: vi.fn(), readResource: vi.fn(), saveResource: vi.fn(),
    ...overrides,
  }
  wrapper = mount(FileTransferPanel, { props: { api, target, machineName: "builder" }, global: { plugins: [i18n] } })
  return { view: wrapper, api, update, unsubscribe }
}
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

test("copies each selected folder as one task into the other pane's actual directory", async () => {
  const { view, api, unsubscribe } = setup()
  await flushPromises()
  expect(view.find("dialog").exists()).toBe(false)
  expect(view.find("h2").exists()).toBe(false)
  expect(view.find('button[aria-label="Close"]').exists()).toBe(false)
  expect(view.findAll("[data-transfer-id]")).toHaveLength(1)
  expect(view.get('[role="progressbar"]').attributes("aria-valuenow")).toBe("50")
  expect(view.text()).toContain("16 B/s")
  expect(api.list).toHaveBeenCalledTimes(2)
  expect(api.list).toHaveBeenCalledWith({ kind: "local" }, undefined)
  expect(api.chooseLocalDirectory).not.toHaveBeenCalled()
  await view.get('input[aria-label="Select assets"]').setValue(true)
  await view.get('button[aria-label="Send to remote"]').trigger("click")
  await flushPromises()
  expect(api.enqueue).toHaveBeenCalledExactlyOnceWith({ kind: "directory", source: task.source, destination: task.destination })
  expect((view.get('input[aria-label="Select assets"]').element as HTMLInputElement).checked).toBe(false)
  wrapper!.unmount(); wrapper = undefined
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(api.cancel).not.toHaveBeenCalled()
})

test("downloads into the desktop home directory without choosing or authorizing a folder", async () => {
  const remoteEntry = { name: "report.txt", path: "D:\\output\\report.txt", kind: "file" as const, size: 5, modifiedAt: 1 }
  const { view, api } = setup({ list: vi.fn(async value => value.kind === "local" ? local : { ...remote, entries: [remoteEntry] }) })
  await flushPromises()
  expect(view.find('[role="alert"]').exists()).toBe(false)
  expect(view.get(`[data-current-path="${local.path}"]`).text()).toBe(local.path)
  await view.get('input[aria-label="Select report.txt"]').setValue(true)
  await view.get('button[aria-label="Download to this computer"]').trigger("click")
  await flushPromises()
  expect(api.enqueue).toHaveBeenCalledExactlyOnceWith({ kind: "file", source: { target, path: remoteEntry.path }, destination: { target: { kind: "local", grantId: "local-files" }, path: local.path } })
  expect(api.chooseLocalDirectory).not.toHaveBeenCalled()
})

test("conflicts offer task-level choices and failed tasks remain retryable", async () => {
  const { view, api, update } = setup()
  await flushPromises()
  update([{ ...task, state: "conflict", error: "Choose Keep both for this folder" }])
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Choose Keep both for this folder")
  await view.findAll('button').find(button => button.text() === "Keep both")!.trigger("click")
  expect(api.retry).toHaveBeenCalledWith(task.id, "rename")
  await flushPromises()
  update([{ ...task, state: "failed", error: "Connection lost" }])
  await flushPromises()
  expect(view.get('[role="alert"]').text()).toBe("Connection lost")
  await view.get('button[aria-label="Retry"]').trigger("click")
  expect(api.retry).toHaveBeenLastCalledWith(task.id, undefined)
})

test("keeps local access grants through navigation and both transfer directions", async () => {
  const { view, api, update } = setup()
  await flushPromises()
  const chosen = { ...local, grantId: "chosen-folder", parentPath: null }
  vi.mocked(api.chooseLocalDirectory).mockResolvedValue(chosen)
  await view.get('button[aria-label="Choose folder"]').trigger("click")
  await flushPromises()
  await view.get('input[aria-label="Select assets"]').setValue(true)
  await view.get('button[aria-label="Send to remote"]').trigger("click")
  await flushPromises()
  expect(api.enqueue).toHaveBeenLastCalledWith({ kind: "directory", source: { target: { kind: "local", grantId: "chosen-folder" }, path: local.entries[0]!.path }, destination: task.destination })

  const remoteEntry = { name: "report.txt", path: "D:\\output\\report.txt", kind: "file" as const, size: 5, modifiedAt: 1 }
  vi.mocked(api.list).mockImplementation(async value => value.kind === "local" ? chosen : { ...remote, entries: [remoteEntry] })
  update([{ ...task, state: "completed" }])
  await flushPromises()
  expect(api.list).toHaveBeenCalledWith({ kind: "local", grantId: "chosen-folder" }, local.path)
  await view.get('input[aria-label="Select report.txt"]').setValue(true)
  await view.get('button[aria-label="Download to this computer"]').trigger("click")
  await flushPromises()
  expect(api.enqueue).toHaveBeenLastCalledWith({ kind: "file", source: { target, path: remoteEntry.path }, destination: { target: { kind: "local", grantId: "chosen-folder" }, path: local.path } })
})

test("an account change clears folder listings, paths, selections, and grants", async () => {
  let event!: (value: CentralEvent) => void
  const unsubscribeAccount = vi.fn()
  const original = client.central
  client.central = { onEvent: (listener: (value: CentralEvent) => void) => { event = listener; return unsubscribeAccount } } as unknown as CentralApi
  try {
    const { view, api, unsubscribe } = setup()
    await flushPromises()
    const chosen = { ...local, grantId: "chosen-folder", path: "/chosen", parentPath: null }
    vi.mocked(api.chooseLocalDirectory).mockResolvedValue(chosen)
    await view.get('button[aria-label="Choose folder"]').trigger("click")
    await flushPromises()
    await view.get('input[aria-label="Select assets"]').setValue(true)
    expect(view.get('button[aria-label="Send to remote"]').attributes("aria-disabled")).toBeUndefined()
    let releaseLocal!: (listing: FileListing) => void
    let releaseRemote!: (listing: FileListing) => void
    vi.mocked(api.list).mockImplementation(value => value.kind === "local"
      ? new Promise(resolve => { releaseLocal = resolve })
      : new Promise(resolve => { releaseRemote = resolve }))
    const listed = vi.mocked(api.list).mock.calls.length
    event({ type: "accountChanged" })
    await flushPromises()
    expect(view.find("[data-current-path]").exists()).toBe(false)
    expect(view.get('button[aria-label="Send to remote"]').attributes("aria-disabled")).toBe("true")
    expect(view.get('button[aria-label="Download to this computer"]').attributes("aria-disabled")).toBe("true")
    expect(vi.mocked(api.list).mock.calls.slice(listed)).toEqual([
      [{ kind: "local" }, undefined],
      [target, undefined],
    ])
    releaseLocal({ ...local, grantId: "next-grant" })
    releaseRemote(remote)
    await flushPromises()
    expect(api.list).not.toHaveBeenCalledWith({ kind: "local", grantId: "chosen-folder" }, expect.anything())
    expect((view.get('input[aria-label="Select assets"]').element as HTMLInputElement).checked).toBe(false)
    view.unmount()
    expect(unsubscribeAccount).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
  } finally {
    client.central = original
    wrapper = undefined
  }
})
