# The release workflow supplies binaries built on Ubuntu 24.04 runners in
# amd64/deskfleet-server and arm64/deskfleet-server beneath the build context.
FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgcc-s1 \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
COPY --chmod=755 ${TARGETARCH}/deskfleet-server /usr/local/bin/deskfleet-server

ENV DESKFLEET_BIND_ADDR=0.0.0.0:8080
USER 10001:10001
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/deskfleet-server"]
