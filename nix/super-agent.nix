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
    # Eve refreshes stale model catalogues during compilation. The locked
    # registry proxy keeps it on the supplied snapshot even outside a sandbox.
    install -Dm644 ${source + /nix/super-agent-model-catalog.json} apps/super-agent/.eve/cache/model-catalog.json
    NODE_USE_ENV_PROXY=1 http_proxy="http://$MITM_CACHE_ADDRESS" https_proxy="http://$MITM_CACHE_ADDRESS" \
      pnpm --filter @deskfleet/super-agent build
    node -e 'const { models } = require("./apps/super-agent/.output/.eve/compile/model-metadata.json");
      const model = models.find(entry => entry.slug === "openai/gpt-5.4-mini");
      if (!model?.providers.some(provider => provider.contextWindowTokens > 0)) throw Error("Missing Gateway context window for openai/gpt-5.4-mini")'
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
    cp -a apps/super-agent/{agent,package.json,tsconfig.json,node_modules,.output} "$agent/"
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
