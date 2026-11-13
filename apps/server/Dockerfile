# The release workflow supplies binaries built on Ubuntu 24.04 runners in
# amd64/deskfleet-server and arm64/deskfleet-server beneath the build context,
# alongside the same release's Web build in web/.
FROM ubuntu:26.04@sha256:065aa8626841f16057b78b027b464cd59c4fac36c204c72dcbf48d66f5fa8a96

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgcc-s1 \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
COPY --chmod=755 ${TARGETARCH}/deskfleet-server /usr/local/bin/deskfleet-server
COPY web/ /usr/share/deskfleet/web/

ENV DESKFLEET_BIND_ADDR=0.0.0.0:8080
ENV DESKFLEET_WEB_DIRECTORY=/usr/share/deskfleet/web
USER 10001:10001
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/deskfleet-server"]
