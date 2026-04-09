FROM rust:1.82-slim AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src/ src/
COPY migrations/ migrations/
RUN apt-get update && apt-get install -y --no-install-recommends libsqlite3-dev && rm -rf /var/lib/apt/lists/*
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/hexfield-server /usr/local/bin/
EXPOSE 7700
ENV HEXFIELD_HOST=0.0.0.0
ENV HEXFIELD_PORT=7700
ENTRYPOINT ["hexfield-server"]
