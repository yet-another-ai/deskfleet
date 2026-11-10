{
  lib,
  stdenvNoCC,
  nodejs,
  pnpm,
  importPnpmLock,
  iplConfigHook,
  source ? ../.,
  webConfig ? { },
}:
let
  version = (builtins.fromJSON (builtins.readFile (source + /package.json))).version;
  daemonManifest = builtins.fromJSON (builtins.readFile (source + /apps/daemon/package.json));
  componentsManifest = builtins.fromJSON (
    builtins.readFile (source + /packages/components/package.json)
  );
  dependencyFiles = lib.fileset.unions [
    (source + /package.json)
    (source + /pnpm-lock.yaml)
    (source + /pnpm-workspace.yaml)
    (source + /patches)
    (source + /apps/web/package.json)
    (source + /packages/capacitor-bridge/package.json)
    (source + /packages/client/package.json)
    (source + /packages/components/package.json)
  ];
  sourceMaps = webConfig.sourcemaps or false;
in
assert lib.assertMsg (
  daemonManifest.dependencies."@agentclientprotocol/sdk"
  == componentsManifest.devDependencies."@agentclientprotocol/sdk"
) "The Web build's shared daemon helpers and UI must use the same ACP SDK version";
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "deskfleet-web";
  inherit version;

  src = lib.fileset.toSource {
    root = source;
    fileset = lib.fileset.unions [
      dependencyFiles
      (source + /tsconfig.json)
      (source + /apps/web/index.html)
      (source + /apps/web/tsconfig.json)
      (source + /apps/web/vite.config.ts)
      (source + /apps/web/public)
      (source + /apps/web/src)
      (source + /packages/capacitor-bridge/src)
      (source + /packages/client/src)
      (source + /packages/components/src)
      (source + /packages/components/locales)
      (source + /packages/components/uno.config.ts)
      # The browser shares wire contracts and pure helpers with the daemon.
      (lib.fileset.fileFilter (file: lib.hasSuffix "-protocol.ts" file.name) (source + /apps/daemon/src))
      (source + /apps/daemon/src/agent-command-results.ts)
      (source + /apps/daemon/src/agents/plans.ts)
      (source + /apps/daemon/src/agents/questions.ts)
      (source + /apps/daemon/src/files-wire.ts)
      (source + /apps/daemon/src/titles.ts)
      (source + /crates/protocol/control.ts)
    ];
  };

  # Each lockfile package is fetched by its registry integrity. Lockfile updates
  # change those inputs directly; there is no aggregate fixed-output hash to refresh.
  mitmCache = importPnpmLock {
    inherit (finalAttrs) pname version;
    lockFile = source + /pnpm-lock.yaml;
  };

  pnpmInstallFlags = [ "--filter=@deskfleet/web..." ];

  nativeBuildInputs = [
    nodejs
    pnpm
    iplConfigHook
  ];

  # These are client-public settings. Upload credentials stay outside Nix builds.
  # Omitting VITE_DESKFLEET_SERVER_URL keeps the image's Web client same-origin.
  env = {
    VITE_STATSIG_CLIENT_KEY = webConfig.statsigClientKey or "";
    VITE_STATSIG_ENVIRONMENT = webConfig.statsigEnvironment or "";
    VITE_SENTRY_DSN = webConfig.sentryDsn or "";
    VITE_SENTRY_ENVIRONMENT = webConfig.sentryEnvironment or "";
    VITE_SENTRY_RELEASE = webConfig.sentryRelease or "";
    VITE_SENTRY_DIST = "web";
    DESKFLEET_SOURCEMAPS = if sourceMaps then "1" else "0";
  };

  outputs = [
    "out"
    "sourcemaps"
  ];
  strictDeps = true;

  buildPhase = ''
    runHook preBuild
    # Browser-shared daemon helpers resolve ACP relative to the daemon tree.
    # Reuse the SDK already installed for the UI, without installing agents or
    # native daemon packages in this static Web build.
    mkdir -p apps/daemon/node_modules/@agentclientprotocol
    ln -s "$PWD/packages/components/node_modules/@agentclientprotocol/sdk" \
      apps/daemon/node_modules/@agentclientprotocol/sdk
    pnpm --filter @deskfleet/web build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out" "$sourcemaps"
    cp -r apps/web/dist/. "$out/"
    ${lib.optionalString sourceMaps ''cp -r apps/web/dist/. "$sourcemaps/"''}
    find "$out" -name '*.map' -delete
    runHook postInstall
  '';

  meta = {
    description = "DeskFleet browser client";
    homepage = "https://github.com/yet-another-ai/deskfleet";
    license = lib.licenses.asl20;
    platforms = lib.platforms.linux;
  };
})
