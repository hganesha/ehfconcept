FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY config ./config
COPY domains ./domains
RUN --mount=type=cache,id=ehf-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --config.minimum-release-age=0 --network-concurrency=4 --fetch-retries=5 --fetch-timeout=120000
ENV NODE_ENV=production
