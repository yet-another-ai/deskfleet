{
  dockerTools,
  runCommand,
  cacert,
  bashInteractive,
  coreutils,
  server,
  web,
}:
let
  # Keep the image's public paths stable while the store objects for the server,
  # Web application, and runtime libraries can occupy independent layers.
  root = runCommand "deskfleet-server-root" { } ''
    mkdir -p "$out/usr/local/bin" "$out/usr/share/deskfleet" "$out/etc/ssl/certs"
    ln -s ${server}/bin/deskfleet-server "$out/usr/local/bin/deskfleet-server"
    ln -s ${web} "$out/usr/share/deskfleet/web"
    ln -s ${cacert}/etc/ssl/certs/ca-bundle.crt "$out/etc/ssl/certs/ca-certificates.crt"
  '';
in
dockerTools.buildLayeredImage {
  name = "deskfleet-server";
  tag = server.version;
  contents = [
    root
    bashInteractive
    coreutils
  ];
  extraCommands = ''
    mkdir -p tmp
    chmod 1777 tmp
  '';
  config = {
    Entrypoint = [ "/usr/local/bin/deskfleet-server" ];
    Env = [
      "PATH=/usr/local/bin:/bin"
      "DESKFLEET_BIND_ADDR=0.0.0.0:8080"
      "DESKFLEET_WEB_DIRECTORY=/usr/share/deskfleet/web"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
    ];
    User = "10001:10001";
    ExposedPorts."8080/tcp" = { };
    StopSignal = "SIGTERM";
    Labels = {
      "org.opencontainers.image.title" = "DeskFleet server";
      "org.opencontainers.image.description" = "DeskFleet API and same-version Web application";
      "org.opencontainers.image.source" = "https://github.com/yet-another-ai/deskfleet";
      "org.opencontainers.image.version" = server.version;
      "org.opencontainers.image.licenses" = "Apache-2.0";
    };
  };
}
