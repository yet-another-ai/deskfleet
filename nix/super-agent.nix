{
  lib,
  stdenvNoCC,
  makeWrapper,
  nodejs,
  pnpm,
  importPnpmLock,
  iplConfigHook,
  source ? ../.,
}:
let
  version = (builtins.fromJSON (builtins.readFile (source + /package.json))).version;
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "deskfleet-super-agent";
  inherit version;

  src = lib.fileset.toSource {
    root = source;
    fileset = lib.fileset.unions [
      (source + /package.json)
      (source + /pnpm-lock.yaml)
      (source + /pnpm-workspace.yaml)
      (source + /patches)
      (source + /tsconfig.json)
      (source + /nix/super-agent-model-catalog.json)
      (source + /apps/super-agent/package.json)
      (source + /apps/super-agent/tsconfig.json)
      (source + /apps/super-agent/agent)
    ];
  };

  mitmCache = importPnpmLock {
    inherit (finalAttrs) pname version;
    lockFile = source + /pnpm-lock.yaml;
  };
  pnpmInstallFlags = [ "--filter=@deskfleet/super-agent..." ];
  nativeBuildInputs = [
    nodejs
    pnpm
    iplConfigHook
    makeWrapper
  ];
  strictDeps = true;
  dontStrip = true;

  buildPhase = ''
    runHook preBuild
    pnpm --filter @deskfleet/super-agent typecheck
    # An in-place production install leaves orphaned dev packages in .pnpm.
    rm -rf node_modules apps/super-agent/node_modules
    CI=true pnpm --filter @deskfleet/super-agent install --prod --offline --ignore-scripts --frozen-lockfile
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    workspace="$out/lib/deskfleet-super-agent"
    agent="$workspace/apps/super-agent"
    mkdir -p "$agent" "$out/bin"
    # Preserve pnpm's relative links from the app to the workspace virtual store.
    cp -a node_modules tsconfig.json "$workspace/"
    cp -a apps/super-agent/{agent,package.json,tsconfig.json,node_modules} "$agent/"
    # Eve embeds absolute paths to the authored agent in its server bundle.
    # Compile at the installed location so those paths survive the build.
    install -Dm644 nix/super-agent-model-catalog.json "$agent/.eve/cache/model-catalog.json"
    pushd "$agent"
    # Eve refreshes stale model catalogues. Node's fetch uses the locked registry
    # proxy so that even an unsandboxed build consumes the pinned snapshot.
    NODE_USE_ENV_PROXY=1 http_proxy="http://$MITM_CACHE_ADDRESS" https_proxy="http://$MITM_CACHE_ADDRESS" \
      node node_modules/eve/bin/eve.js build
    node -e 'const { models } = require("./.output/.eve/compile/model-metadata.json");
      const model = models.find(entry => entry.slug === "openai/gpt-5.4-mini");
      if (!model?.providers.some(provider => provider.contextWindowTokens > 0)) throw Error("Missing Gateway context window for openai/gpt-5.4-mini")'
    rm -rf .eve
    popd
    makeWrapper ${nodejs}/bin/node "$out/bin/deskfleet-super-agent" \
      --chdir "$agent" --add-flags "$agent/node_modules/eve/bin/eve.js" --prefix PATH : ${nodejs}/bin
    makeWrapper ${nodejs}/bin/node "$out/bin/bootstrap" \
      --chdir "$agent" --add-flags "$agent/node_modules/@workflow/world-postgres/bin/setup.js" --prefix PATH : ${nodejs}/bin
    runHook postInstall
  '';

  meta = {
    description = "DeskFleet hosted Super Agent service";
    homepage = "https://github.com/yet-another-ai/deskfleet";
    license = lib.licenses.asl20;
    mainProgram = "deskfleet-super-agent";
    platforms = lib.platforms.linux;
  };
})
