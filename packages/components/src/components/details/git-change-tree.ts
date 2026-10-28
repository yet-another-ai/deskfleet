import type { GitFileChange } from "../../../../../apps/daemon/src/git-protocol.ts"

export interface ChangeDirectory {
  name: string
  /** Repository-relative directory path, without a trailing slash. */
  path: string
  directories: ChangeDirectory[]
  files: GitFileChange[]
}

export interface ChangeTree {
  directories: ChangeDirectory[]
  files: GitFileChange[]
}

export interface ChangeTreeRow {
  type: "directory" | "file"
  depth: number
  name: string
  path: string
  /** Set for directories. True when the row's children are hidden. */
  collapsed?: boolean
  change?: GitFileChange
}

function compareName(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
}

function fileName(path: string): string {
  const index = path.lastIndexOf("/")
  return index < 0 ? path : path.slice(index + 1)
}

function sortDirectory(directory: ChangeDirectory): void {
  directory.directories.sort((left, right) => compareName(left.name, right.name))
  directory.files.sort((left, right) => compareName(fileName(left.path), fileName(right.path)))
  for (const child of directory.directories) sortDirectory(child)
}

/** Group repository-relative Git paths into directories, with folders before files. */
export function buildChangeTree(changes: readonly GitFileChange[]): ChangeTree {
  const root: ChangeDirectory = { name: "", path: "", directories: [], files: [] }
  for (const change of changes) {
    const parts = change.path.split("/").filter(part => part.length > 0)
    const name = parts.pop()
    if (!name) continue
    let node = root
    let path = ""
    for (const part of parts) {
      path = path ? `${path}/${part}` : part
      let child = node.directories.find(directory => directory.name === part)
      if (!child) {
        child = { name: part, path, directories: [], files: [] }
        node.directories.push(child)
      }
      node = child
    }
    node.files.push(change)
  }
  sortDirectory(root)
  return { directories: root.directories, files: root.files }
}

/** Visible rows for a tree, skipping children of collapsed directories. */
export function flattenChangeTree(
  tree: ChangeTree,
  collapsed: Readonly<Record<string, true>>,
  directoryKey: (path: string) => string,
): ChangeTreeRow[] {
  const rows: ChangeTreeRow[] = []
  const visit = (node: ChangeTree, depth: number): void => {
    for (const directory of node.directories) {
      rows.push({
        type: "directory",
        depth,
        name: directory.name,
        path: directory.path,
        collapsed: collapsed[directoryKey(directory.path)] === true,
      })
      if (!collapsed[directoryKey(directory.path)]) visit(directory, depth + 1)
    }
    for (const change of node.files) {
      rows.push({ type: "file", depth, name: fileName(change.path), path: change.path, change })
    }
  }
  visit(tree, 0)
  return rows
}
