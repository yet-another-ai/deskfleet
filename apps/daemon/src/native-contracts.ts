import type * as native from "@deskfleet/native"
import type * as catalog from "@deskfleet/protocol/catalog"
import type * as system from "@deskfleet/protocol/system"

// The platform-neutral protocol package restates these napi-generated records so
// browser clients never depend on the native addon. Type checking fails here when
// the Rust boundary and the restated contract drift apart.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T

export type NativeContracts = [
  Assert<Same<native.CatalogDirectory, catalog.CatalogDirectory>>,
  Assert<Same<native.CatalogWorktree, catalog.CatalogWorktree>>,
  Assert<Same<native.CatalogWorkspace, catalog.CatalogWorkspace>>,
  Assert<Same<native.CatalogWorkspaceSession, catalog.CatalogWorkspaceSession>>,
  Assert<Same<native.CatalogSnapshot, catalog.NativeCatalogSnapshot>>,
  Assert<Same<NonNullable<native.SystemStatus["battery"]>, system.BatteryStatus>>,
  Assert<Same<native.SystemStatus, system.NativeSystemStatus>>,
]
