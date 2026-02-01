# Loki Mode Docker Image
# Build: docker build -t loki-mode .
# Run: docker run -it -v $(pwd):/workspace loki-mode

FROM ubuntu:24.04

LABEL maintainer="Lokesh Mure"
LABEL version="5.8.9"
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

# Install Node.js 20 LTS from NodeSource (fixes nodejs/npm CVEs)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm cache clean --force

# Install GitHub CLI directly from releases (latest version, not from apt)
# This avoids CVE-2024-52308 in older Ubuntu-packaged versions
RUN ARCH=$(dpkg --print-architecture) && \
    GH_VERSION=$(curl -s https://api.github.com/repos/cli/cli/releases/latest | jq -r .tag_name | sed 's/v//') && \
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

# Create app directory
WORKDIR /opt/loki-mode

# Copy Loki Mode files
COPY SKILL.md VERSION ./
COPY autonomy/ ./autonomy/
COPY skills/ ./skills/
COPY references/ ./references/
COPY docs/ ./docs/

# Make scripts executable
RUN chmod +x autonomy/run.sh autonomy/loki

# Set up symlinks
RUN mkdir -p /root/.claude/skills && \
    ln -sf /opt/loki-mode /root/.claude/skills/loki-mode && \
    ln -sf /opt/loki-mode/autonomy/loki /usr/local/bin/loki

# Set workspace as working directory
WORKDIR /workspace

# Run as non-root user for security (optional, uncomment if needed)
# RUN useradd -m -s /bin/bash loki && chown -R loki:loki /opt/loki-mode
# USER loki

# Default command shows help
CMD ["loki", "help"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD loki version || exit 1
