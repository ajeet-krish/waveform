# Waveform API image: multi-stage build of the release binary, then a
# slim runtime. Deployed by Render (render.yaml at the repository root);
# PORT is injected by the platform and read by the API config.

FROM rust:1-bookworm AS builder
WORKDIR /app

# Cache the dependency build: manifests and the lockfile change far less
# often than sources, so `cargo fetch` warms the registry while the
# dependency layer is still unchanged. The placeholder targets satisfy
# cargo's requirement of at least one target per package; the real
# sources arrive with the next COPY.
COPY Cargo.toml Cargo.lock ./
COPY apps/api/Cargo.toml apps/api/Cargo.toml
COPY crates/analytics/Cargo.toml crates/analytics/Cargo.toml
COPY crates/db/Cargo.toml crates/db/Cargo.toml
COPY crates/scoring/Cargo.toml crates/scoring/Cargo.toml
COPY crates/sync/Cargo.toml crates/sync/Cargo.toml
RUN mkdir -p apps/api/src crates/analytics/src crates/db/src crates/scoring/src crates/sync/src \
    && touch apps/api/src/main.rs crates/analytics/src/lib.rs crates/db/src/lib.rs \
        crates/scoring/src/lib.rs crates/sync/src/lib.rs \
    && cargo fetch

COPY . .
RUN cargo build --release -p waveform-api

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/waveform-api /usr/local/bin/waveform-api

# The platform overrides this with its own port (Render injects PORT);
# 8080 is the local default.
EXPOSE 8080
CMD ["waveform-api"]
