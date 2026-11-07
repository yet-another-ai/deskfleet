# Vendored and adapted from importPnpmLock.nix (MIT):
# https://github.com/Scrumplex/importPnpmLock.nix
{
  lib,
  runCommand,
  yq-go,
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

  importYAMLDocuments =
    file:
    let
      json =
        runCommand "${pname}-pnpm-lock.json"
          {
            nativeBuildInputs = [ yq-go ];
          }
          ''
            yq --output-format json eval-all '[.]' ${file} > $out
          '';
    in
    lib.importJSON json;

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

  documents = importYAMLDocuments lockFile;
  data = lib.last documents;

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

  # Directory resolutions are workspace packages already present in src.
  filterPackageEntry = _: package: (package.resolution or { }).type or null != "directory";

  lockFileVersion = data.lockfileVersion or null;
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
assert lib.assertMsg (data ? packages) ''
  File ${toString lockFile} does not contain a list of locked packages.
  Is it a valid lock file?
'';
mitm-cache.fetch {
  name = "${pname}-pnpm-mitm-cache-${version}";
  data = lib.mapAttrs' mapPackageToMitmCacheEntry (lib.filterAttrs filterPackageEntry data.packages);
}
