# Vendored and adapted from importPnpmLock.nix (MIT):
# https://github.com/Scrumplex/importPnpmLock.nix
#
# Parses pnpm-lock.yaml in pure Nix (no IFD) so `nix flake check --all-systems`
# can instantiate both Linux architectures on either host.
{
  lib,
  mitm-cache,
  config,
}:
{
  pname,
  version,
  lockFile,
  manualEntries ? { },
}:
let
  supportedLockFileVersions = [
    "9.0"
  ];

  # pnpm-lock.yaml is YAML, which Nix cannot load as JSON. The lockfile we commit
  # only uses single-line package keys and `resolution: {integrity: ...}`
  # entries under `packages:`, so a line scan is enough and stays IFD-free.
  lines = lib.splitString "\n" (builtins.readFile lockFile);

  packageKeyMatch = builtins.match "  ('([^']+)'|\"([^\"]+)\"|([^[:space:]:]+)):";
  integrityMatch = builtins.match "    resolution: [{]integrity: (.*)[}]";
  resolutionMatch = builtins.match "    resolution: (.*)";
  lockfileVersionMatch = builtins.match "lockfileVersion: ['\"]?([^'\"]+)['\"]?";
  topLevelKeyMatch = builtins.match "([A-Za-z][^:]*):";

  packageNameFromMatch =
    m:
    if m == null then
      null
    else if builtins.elemAt m 1 != null then
      builtins.elemAt m 1
    else if builtins.elemAt m 2 != null then
      builtins.elemAt m 2
    else
      builtins.elemAt m 3;

  isPackageKey = name: name != null && builtins.match ".+@.+" name != null;

  requireNoPendingPackage =
    state: context:
    assert lib.assertMsg (state.current == null) ''
      Package ${state.current} has no single-line integrity resolution (${context}).

      The pure Nix pnpm lockfile parser only supports
      `resolution: {integrity: ...}` under `packages:`.
      Add support for this resolution shape, or provide manualEntries.
    '';
    state;

  parsed =
    builtins.foldl'
      (
        state: line:
        let
          versionHit = lockfileVersionMatch line;
          keyHit = packageNameFromMatch (packageKeyMatch line);
          integrityHit = integrityMatch line;
          resolutionHit = resolutionMatch line;
          topLevelHit = topLevelKeyMatch line;
        in
        if state.lockfileVersion == null && versionHit != null then
          state // { lockfileVersion = builtins.head versionHit; }
        else if line == "packages:" then
          requireNoPendingPackage state "entering packages"
          // {
            inPackages = true;
            current = null;
          }
        else if state.inPackages && topLevelHit != null && builtins.head topLevelHit != "packages" then
          # Left the packages section for another top-level mapping (e.g. snapshots).
          requireNoPendingPackage state "leaving packages"
          // {
            inPackages = false;
            current = null;
          }
        else if state.inPackages && isPackageKey keyHit then
          requireNoPendingPackage state "starting ${keyHit}"
          // {
            current = keyHit;
          }
        else if state.inPackages && state.current != null && integrityHit != null then
          state
          // {
            packages = state.packages // {
              ${state.current} = {
                resolution = {
                  integrity = builtins.head integrityHit;
                };
              };
            };
            current = null;
          }
        else if state.inPackages && state.current != null && resolutionHit != null then
          assert lib.assertMsg false ''
            Package ${state.current} has unsupported resolution `${builtins.head resolutionHit}`.

            The pure Nix pnpm lockfile parser only supports
            `resolution: {integrity: ...}` under `packages:`.
            Add support for this resolution shape, or provide manualEntries for
            "${state.current}".
          '';
          state
        else
          state
      )
      {
        lockfileVersion = null;
        inPackages = false;
        current = null;
        packages = { };
      }
      lines;

  finalized = requireNoPendingPackage parsed "end of lockfile";

  splitName = builtins.match "^(@?[^@]+)@(.+)$";

  urlFromName =
    name:
    let
      c = splitName name;
      scopedName = builtins.head c;
      packageVersion = lib.last c;
      versionIsUrl = lib.hasPrefix "http" packageVersion;
      packageName = lib.last (lib.splitString "/" scopedName);
    in
    if versionIsUrl then
      packageVersion
    else
      "https://registry.npmjs.org/${scopedName}/-/${packageName}-${packageVersion}.tgz";

  registryOverrides = config.npmRegistryOverrides or { };

  applyMirrorToUrl =
    url:
    let
      mUrl = builtins.match "(.+)://([^/]+)/(.+)" url;
      scheme = builtins.elemAt mUrl 0;
      host = builtins.elemAt mUrl 1;
      path = builtins.elemAt mUrl 2;
    in
    if registryOverrides ? "${host}" then
      "${scheme}://${registryOverrides."${host}"}/${path}"
    else
      url;

  mapPackageToMitmCacheEntry =
    name: package:
    let
      resolution = package.resolution or { };
      url = resolution.tarball or (applyMirrorToUrl (urlFromName name));
      integrity = resolution.integrity or manualEntries.${name} or null;
    in
    assert lib.assertMsg (integrity != null) ''
      Package ${name} doesn't have an integrity entry.

      To fix this, add a manual entry using

        importPnpmLock {
          lockFile = ${toString lockFile};
          manualEntries = {
            "${name}" = "";
          };
        }
    '';
    lib.nameValuePair url {
      hash = integrity;
    };

  lockFileVersion = finalized.lockfileVersion;
  packages = finalized.packages;
in
assert lib.assertMsg (lockFileVersion != null) ''
  lockFile ${toString lockFile} does not look like a supported lock file.
  Unable to read lockfileVersion.
'';
assert lib.assertMsg (builtins.elem lockFileVersion supportedLockFileVersions) ''
  File ${toString lockFile} is not a supported lock file.

  Supported versions are ${lib.concatStringsSep ", " supportedLockFileVersions}

  Found version ${lockFileVersion}
'';
assert lib.assertMsg (packages != { }) ''
  File ${toString lockFile} does not contain a list of locked packages.
  Is it a valid lock file?
'';
mitm-cache.fetch {
  name = "${pname}-pnpm-mitm-cache-${version}";
  data = lib.mapAttrs' mapPackageToMitmCacheEntry packages;
}
