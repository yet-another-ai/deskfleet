export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${Math.floor(bytes)} B`
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4)
  const value = bytes / 1024 ** unit
  return `${value.toFixed(value < 10 ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][unit]}`
}
