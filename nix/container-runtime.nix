{
  runCommand,
  bashInteractive,
  cacert,
  coreutils,
  curl,
  jq,
}:
let
  caBundlePath = "/etc/ssl/certs/ca-certificates.crt";
  caBundle = runCommand "deskfleet-container-ca-bundle" { } ''
    mkdir -p "$out/etc/ssl/certs"
    ln -s ${cacert}/etc/ssl/certs/ca-bundle.crt "$out${caBundlePath}"
  '';
in
{
  inherit caBundlePath;
  # Shared shell, CA certificates, and healthcheck utilities for service images.
  contents = [
    caBundle
    bashInteractive
    coreutils
    curl.bin
    jq.bin
  ];
  env = [
    "SSL_CERT_FILE=${caBundlePath}"
  ];
  extraCommands = ''
    mkdir -p tmp
    chmod 1777 tmp
  '';
}
