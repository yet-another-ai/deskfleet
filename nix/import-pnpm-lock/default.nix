# Vendored and adapted from importPnpmLock.nix (MIT):
# https://github.com/Scrumplex/importPnpmLock.nix
# Fetches each pnpm-lock.yaml package by its registry integrity so lockfile
# updates do not require a separate aggregate fixed-output hash.
{
  callPackage,
}:
{
  importPnpmLock = callPackage ./importPnpmLock.nix { };
  iplConfigHook = callPackage ./iplConfigHook.nix { };
}
