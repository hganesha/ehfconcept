# syntax=docker/dockerfile:1.7
FROM rust:1.94-slim-bookworm@sha256:cf9dd0ec73e75f827fe59123fff9dc65af1a1c8363c3c31ee8d7f8ad0b6a5fb2 AS compiler
WORKDIR /src
RUN apt-get update \
    && apt-get install --no-install-recommends --assume-yes git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,id=ehf-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=ehf-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=ehf-cargo-target,target=/src/target \
    cargo build --release --locked -p harness-compiler \
    && cp target/release/harnessc /usr/local/bin/harnessc

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS builder
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts/build-service.mjs ./scripts/build-service.mjs
RUN --mount=type=cache,id=ehf-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --prefer-offline --frozen-lockfile --config.minimum-release-age=0 --network-concurrency=4 --fetch-retries=5 --fetch-timeout=120000 \
    && node scripts/build-service.mjs all

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runner
WORKDIR /app
ARG SERVICE_NAME
ARG IMAGE_REVISION=unknown
LABEL org.opencontainers.image.title="ehf-${SERVICE_NAME}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.source="https://github.com/hganesha/ehfconcept"
ENV NODE_ENV=production
ENV HARNESSC_PATH=/usr/local/bin/harnessc
COPY --from=builder /src/dist/services/${SERVICE_NAME}/server.mjs /app/server.mjs
COPY --from=compiler /usr/local/bin/harnessc /usr/local/bin/harnessc
COPY config ./config
COPY domains ./domains
RUN groupadd --system --gid 1001 ehf \
    && useradd --system --uid 1001 --gid ehf --home-dir /nonexistent ehf \
    && chown -R ehf:ehf /app
USER 1001:1001
CMD ["node", "/app/server.mjs"]
