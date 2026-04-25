# Loki Mode Docker Image (multi-arch: amd64 + arm64)
# Build: docker buildx build --platform linux/amd64,linux/arm64 -t loki-mode .
# Run:   docker run -it -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v $(pwd):/workspace asklokesh/loki-mode start prd.md
# Dash:  docker run -it -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -p 57374:57374 -v $(pwd):/workspace asklokesh/loki-mode start --api prd.md

FROM ubuntu:24.04

LABEL maintainer="Lokesh Mure"
LABEL version="7.3.0"
LABEL description="Loki Mode by Autonomi - Multi-agent autonomous startup system for Claude Code, Codex CLI, and Gemini CLI"
LABEL url="https://www.autonomi.dev/"

# Prevent interactive prompts during install
ENV DEBIAN_FRONTEND=noninteractive

# Install base dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    gnupg \
    jq \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS from NodeSource with GPG verification
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm cache clean --force

# Install GitHub CLI directly from releases (pinned version for reliability)
# This avoids CVE-2024-52308 in older Ubuntu-packaged versions
ARG GH_VERSION=2.65.0
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" -o /tmp/gh.tar.gz && \
    tar -xzf /tmp/gh.tar.gz -C /tmp && \
    mv /tmp/gh_${GH_VERSION}_linux_${ARCH}/bin/gh /usr/local/bin/gh && \
    rm -rf /tmp/gh* && \
    gh --version

# Install Bun runtime (pinned) for the TypeScript CLI shipped under loki-ts/.
# bin/loki shim routes ported commands to `bun loki-ts/dist/loki.js`; unported
# commands fall through to autonomy/loki (bash). See ADR-001.
ARG BUN_VERSION=1.3.13
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && mv /root/.bun/bin/bun /usr/local/bin/bun \
    && rm -rf /root/.bun \
    && bun --version

# Upgrade Python packages to fix setuptools/wheel CVEs
# Remove old debian-managed packages first, then install fixed versions
RUN rm -rf /usr/lib/python3/dist-packages/setuptools* \
    /usr/lib/python3/dist-packages/wheel* \
    /usr/lib/python3/dist-packages/pkg_resources* \
    && pip3 install --no-cache-dir --break-system-packages \
    "setuptools>=78.1.1" \
    "wheel>=0.46.2"

# Update npm to get latest dependency fixes (tar, glob, cross-spawn)
RUN npm install -g npm@latest \
    && npm cache clean --force

# Security: Create non-root user (UID 1000 for host volume mount compatibility)
# NodeSource may create a user with UID 1000, so check first and rename/reuse if needed
RUN if id -u 1000 >/dev/null 2>&1; then \
      existing_user=$(getent passwd 1000 | cut -d: -f1); \
      usermod -l loki -d /home/loki -m "$existing_user" 2>/dev/null || true; \
      groupmod -n loki "$(id -gn 1000)" 2>/dev/null || true; \
    else \
      useradd -m -s /bin/bash -u 1000 loki; \
    fi

# Create app directory
WORKDIR /opt/loki-mode

# Copy Loki Mode files
COPY --chown=loki:loki SKILL.md VERSION ./
COPY --chown=loki:loki autonomy/ ./autonomy/
COPY --chown=loki:loki skills/ ./skills/
COPY --chown=loki:loki references/ ./references/
COPY --chown=loki:loki docs/ ./docs/
COPY --chown=loki:loki providers/ ./providers/
COPY --chown=loki:loki agents/ ./agents/
COPY --chown=loki:loki memory/ ./memory/
COPY --chown=loki:loki events/ ./events/
COPY --chown=loki:loki dashboard/ ./dashboard/
COPY --chown=loki:loki mcp/ ./mcp/
COPY --chown=loki:loki learning/ ./learning/
COPY --chown=loki:loki magic/ ./magic/
COPY --chown=loki:loki templates/ ./templates/
COPY --chown=loki:loki integrations/ ./integrations/
COPY --chown=loki:loki completions/ ./completions/

# Bun runtime artifacts: shim + pre-built TypeScript bundle.
# loki-ts/dist/loki.js is built by `bun run build` (see loki-ts/scripts/build.ts)
# and committed to the repo; ~37 KiB minified.
COPY --chown=loki:loki bin/ ./bin/
COPY --chown=loki:loki loki-ts/dist/ ./loki-ts/dist/

# Install dashboard Python dependencies
RUN pip3 install --no-cache-dir --break-system-packages \
    -r dashboard/requirements.txt

# Make scripts executable
RUN chmod +x autonomy/run.sh autonomy/loki autonomy/app-runner.sh autonomy/prd-checklist.sh autonomy/playwright-verify.sh autonomy/completion-council.sh bin/loki

# Set up symlinks for loki user. /usr/local/bin/loki points at the bin/loki
# shim so ported commands route through Bun while unported commands fall
# through to autonomy/loki (bash).
RUN mkdir -p /home/loki/.claude/skills && \
    ln -sf /opt/loki-mode /home/loki/.claude/skills/loki-mode && \
    ln -sf /opt/loki-mode/bin/loki /usr/local/bin/loki

# Security: Set ownership and switch to non-root user
RUN mkdir -p /workspace && \
    chown -R loki:loki /opt/loki-mode /workspace /home/loki

# Set workspace as working directory
WORKDIR /workspace

# Expose dashboard/API port
EXPOSE 57374

# Security: Switch to non-root user
USER loki

# Entrypoint: `docker run asklokesh/loki-mode start prd.md` runs `loki start prd.md`
ENTRYPOINT ["loki"]
CMD ["help"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD loki version || exit 1
