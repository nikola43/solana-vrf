# Multi-stage build for the VRF oracle backend.
# Build: docker build -t vrf-backend .
# Run:   docker run --env-file .env -p 8080:8080 vrf-backend

FROM rust:1.84-bookworm AS builder

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src/ src/

RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/vrf-backend /usr/local/bin/vrf-backend

EXPOSE 8080

ENTRYPOINT ["vrf-backend"]
