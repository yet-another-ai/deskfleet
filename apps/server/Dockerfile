# The release workflow supplies binaries built on Ubuntu 24.04 runners in
# amd64/deskfleet-server and arm64/deskfleet-server beneath the build context.
FROM ubuntu:24.04@sha256:24737cef17f4e22b1977df7d9a05e77c4e28b7da5b8911f8d8ccda136bf3573c

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
