FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS node

FROM node AS build
WORKDIR /workspace
COPY mise.toml package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY apps/super-agent/package.json apps/super-agent/package.json
RUN npm install --global "pnpm@$(sed -n 's/^pnpm = "\([^"]*\)"/\1/p' mise.toml)" \
    && pnpm --filter @deskfleet/super-agent install --frozen-lockfile

COPY tsconfig.json ./
COPY apps/super-agent/tsconfig.json apps/super-agent/
COPY apps/super-agent/agent/ apps/super-agent/agent/
# Eve can finish a build with an empty Gateway catalogue. Its default model
# needs a recorded context window to start the first turn.
RUN pnpm --filter @deskfleet/super-agent typecheck \
    && pnpm --filter @deskfleet/super-agent build \
    && node -e 'const { models } = require("./apps/super-agent/.output/.eve/compile/model-metadata.json"); \
    const model = models.find(entry => entry.slug === "openai/gpt-5.4-mini"); \
    if (!model?.providers.some(provider => provider.contextWindowTokens > 0)) throw Error("Missing Gateway context window for openai/gpt-5.4-mini")' \
    && CI=true pnpm --filter @deskfleet/super-agent install --prod --offline --frozen-lockfile \
    && rm -rf apps/super-agent/.eve

FROM node
WORKDIR /workspace/apps/super-agent
COPY --from=build /workspace/tsconfig.json /workspace/tsconfig.json
COPY --from=build /workspace/node_modules /workspace/node_modules
COPY --from=build --chown=node:node /workspace/apps/super-agent/ ./
ENV NODE_ENV=production
ENV PATH=/workspace/apps/super-agent/node_modules/.bin:${PATH}
USER node
EXPOSE 3100
CMD ["eve", "start", "--host", "0.0.0.0", "--port", "3100"]
