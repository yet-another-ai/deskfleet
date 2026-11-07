# Vendored and adapted from importPnpmLock.nix (MIT):
# https://github.com/Scrumplex/importPnpmLock.nix
{
  makeSetupHook,
  stdenvNoCC,
  mitm-cache,
  writableTmpDirAsHomeHook,
}:
makeSetupHook {
  name = "import-pnpm-lock-config-hook";
  propagatedBuildInputs = [
    mitm-cache
    writableTmpDirAsHomeHook
  ];
  substitutions = {
    npmArch = stdenvNoCC.targetPlatform.node.arch;
    npmPlatform = stdenvNoCC.targetPlatform.node.platform;
  };
} ./config-hook.sh
