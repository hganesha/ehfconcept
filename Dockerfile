# The compiler of record. The author plane shells out to this binary, so a deployed
# stack that lacks it cannot emit plans at all -- which is the intended failure mode.
# Previously no Rust reached the image and the author plane compiled plans in
# TypeScript while stamping them with an lgir-core revision it had never run.
FROM rust:1.94-slim-bookworm AS compiler
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
COPY --from=compiler /usr/local/bin/harnessc /usr/local/bin/harnessc
ENV HARNESSC_PATH=/usr/local/bin/harnessc
ENV NODE_ENV=production
