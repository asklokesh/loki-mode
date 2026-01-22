# Loki Mode Docker Image
# Build: docker build -t loki-mode .
# Run: docker run -it -v $(pwd):/workspace loki-mode

FROM ubuntu:22.04

LABEL maintainer="Lokesh Mure"
LABEL version="4.1.0"
LABEL description="Multi-agent autonomous startup system for Claude Code"

# Prevent interactive prompts during install
ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && apt-get install -y \
    bash \
    curl \
    git \
    jq \
    python3 \
    python3-pip \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

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

# Default command shows help
CMD ["loki", "help"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD loki version || exit 1
