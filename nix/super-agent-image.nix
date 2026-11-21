{
  dockerTools,
  runCommand,
  cacert,
  coreutils,
  super-agent,
}:
let
  root = runCommand "deskfleet-super-agent-root" { } ''
    mkdir -p "$out/bin" "$out/etc/ssl/certs"
    ln -s ${super-agent}/bin/deskfleet-super-agent "$out/bin/deskfleet-super-agent"
    ln -s ${super-agent}/bin/bootstrap "$out/bin/bootstrap"
    ln -s ${cacert}/etc/ssl/certs/ca-bundle.crt "$out/etc/ssl/certs/ca-certificates.crt"
  '';
in
dockerTools.buildLayeredImage {
  name = "deskfleet-super-agent";
  tag = super-agent.version;
  contents = [
    root
    coreutils
  ];
  extraCommands = ''
    mkdir -p tmp
    chmod 1777 tmp
  '';
  fakeRootCommands = ''
    install -d -m 0700 -o 10001 -g 10001 .${super-agent.cacheDir}
  '';
  config = {
    Cmd = [
      "deskfleet-super-agent"
      "start"
      "--host"
      "0.0.0.0"
      "--port"
      "3100"
    ];
    Env = [
      "PATH=/bin"
      "HOME=/tmp"
      "NODE_ENV=production"
      "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt"
    ];
    User = "10001:10001";
    ExposedPorts."3100/tcp" = { };
    StopSignal = "SIGTERM";
    Labels = {
      "org.opencontainers.image.title" = "DeskFleet Super Agent";
      "org.opencontainers.image.description" = "DeskFleet hosted conversation coordinator";
      "org.opencontainers.image.source" = "https://github.com/yet-another-ai/deskfleet";
      "org.opencontainers.image.version" = super-agent.version;
      "org.opencontainers.image.licenses" = "Apache-2.0";
    };
  };
}
