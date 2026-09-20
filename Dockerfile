# Build stage — production deps only, from the lockfile.
FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime stage
FROM node:22-slim
ARG BUILD_GIT_VERSION=dev
ARG BUILD_GIT_COMMIT=none
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="Discord Assistant"
LABEL org.opencontainers.image.description="One Discord bot reaching an OpenAI-compatible endpoint from text and voice"
LABEL org.opencontainers.image.vendor="Benjamin Borbe"
LABEL org.opencontainers.image.source="https://github.com/bborbe/ai-assistant"
LABEL org.opencontainers.image.version="${BUILD_GIT_VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${BUILD_GIT_COMMIT}"

WORKDIR /app

COPY --from=builder /app/node_modules /app/node_modules
COPY package.json ./
COPY src/ ./src/
COPY shim/ ./shim/

# The shim is a Python process (shim/claude_openai_shim.py); node:22-slim has
# no python3. It shells out to the `claude` CLI, which reaches the backend via
# the in-cluster claude-code-router (ANTHROPIC_BASE_URL set by the Deployment),
# so the image carries both runtimes and the CLI. One image, two entrypoints:
# the bot Deployment runs ENTRYPOINT below, the shim Deployment overrides the
# command to `python3 -u shim/claude_openai_shim.py`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-yaml git openssh-client curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code

# vault-cli — the assistant's vault CRUD surface; the `sc` identity's allowlist
# grants `Bash(vault-cli:*)`. Taken from the published release tarball rather
# than `go install`: the runtime image carries no Go toolchain, and a static
# binary is what the pod actually execs at runtime.
#
# Checksum-verified against the same release's checksums.txt so a truncated or
# substituted download fails the BUILD, not the first turn that calls the tool —
# a broken binary that only fails at call time looks like an allowlist problem
# and sends the reader to the wrong file. `--version` at the end is the smoke
# test: it proves the extracted binary runs on this base image, which `tar`
# succeeding does not.
ARG VAULT_CLI_VERSION=v0.140.0
RUN set -eu; \
    base="https://github.com/bborbe/vault-cli/releases/download/${VAULT_CLI_VERSION}"; \
    cd /tmp; \
    curl -fsSL -O "${base}/vault-cli_linux_amd64.tar.gz"; \
    curl -fsSL -O "${base}/checksums.txt"; \
    grep ' vault-cli_linux_amd64.tar.gz$' checksums.txt | sha256sum -c -; \
    tar -xzf vault-cli_linux_amd64.tar.gz -C /usr/local/bin vault-cli; \
    chmod 0755 /usr/local/bin/vault-cli; \
    rm -f /tmp/vault-cli_linux_amd64.tar.gz /tmp/checksums.txt; \
    vault-cli --version

ENV NODE_ENV=production
ENV BUILD_GIT_VERSION=${BUILD_GIT_VERSION}
ENV BUILD_GIT_COMMIT=${BUILD_GIT_COMMIT}
ENV BUILD_DATE=${BUILD_DATE}

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# exec node directly so PID 1 receives SIGTERM and graceful shutdown works.
ENTRYPOINT ["node", "src/index.js"]

EXPOSE 8080
