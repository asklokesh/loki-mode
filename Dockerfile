# Loki Mode Docker Image
# Build: docker build -t loki-mode .
# Run: docker run -it -v $(pwd):/workspace loki-mode

FROM ubuntu:24.04

LABEL maintainer="Lokesh Mure"
LABEL version="5.42.1"
LABEL description="Multi-agent autonomous startup system for Claude Code, Codex CLI, and Gemini CLI"

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
COPY --chown=loki:loki memory/ ./memory/
COPY --chown=loki:loki events/ ./events/
COPY --chown=loki:loki dashboard/ ./dashboard/
COPY --chown=loki:loki mcp/ ./mcp/
COPY --chown=loki:loki learning/ ./learning/
COPY --chown=loki:loki templates/ ./templates/
COPY --chown=loki:loki integrations/ ./integrations/

# Install dashboard Python dependencies
RUN pip3 install --no-cache-dir --break-system-packages \
    -r dashboard/requirements.txt

# Make scripts executable
RUN chmod +x autonomy/run.sh autonomy/loki

# Set up symlinks for loki user
RUN mkdir -p /home/loki/.claude/skills && \
    ln -sf /opt/loki-mode /home/loki/.claude/skills/loki-mode && \
    ln -sf /opt/loki-mode/autonomy/loki /usr/local/bin/loki

# Security: Set ownership and switch to non-root user
RUN mkdir -p /workspace && \
    chown -R loki:loki /opt/loki-mode /workspace /home/loki

# Set workspace as working directory
WORKDIR /workspace

# Expose dashboard/API port
EXPOSE 57374

# Security: Switch to non-root user
USER loki

# Default command shows help
CMD ["loki", "help"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD loki version || exit 1
