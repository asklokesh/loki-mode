# Module 4 Lab: Deploy with Docker Compose

## Objective

Deploy Loki Mode using Docker Compose, verify the dashboard is accessible, and configure resource limits.

## Prerequisites

- Docker and Docker Compose installed
- Loki Mode source or repository cloned
- An AI provider API key (e.g., `ANTHROPIC_API_KEY` for Claude)

## Step 1: Review the Docker Compose Configuration

Examine the `docker-compose.yml` at the repository root:

```bash
cat docker-compose.yml
```

Key elements to note:
- The service mounts your current directory as `/workspace` (read-write)
- Git config and SSH keys are mounted read-only
- The dashboard port 57374 is exposed
- GitHub token is passed through from the host environment

## Step 2: Build the Docker Image

```bash
docker-compose build
```

This builds from the `Dockerfile` which installs:
- Ubuntu 24.04 base
- Node.js 20 LTS
- Python 3 with venv support
- Git, jq, GitHub CLI
- Loki Mode and its dependencies

## Step 3: Start with Docker Compose

Create a test project directory and start Loki Mode:

```bash
mkdir -p /tmp/docker-lab && cd /tmp/docker-lab
git init

# Create a minimal PRD
cat > prd.md << 'EOF'
# Hello World API

## Overview
A simple Express.js REST API that returns "Hello, World!" on GET /.

## Requirements
- GET / returns JSON: {"message": "Hello, World!"}
- Responds with HTTP 200
- Unit test verifies the response

## Tech Stack
- Node.js with Express
EOF
```

Start the container (this will invoke the AI provider and may incur costs):

```bash
# Pass your API key through to the container
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY docker-compose run \
  -e ANTHROPIC_API_KEY \
  loki start ./prd.md
```

**Note:** Replace `ANTHROPIC_API_KEY` with the appropriate key for your provider (for example `OPENAI_API_KEY` for Codex).

## Step 4: Verify the Dashboard

While the container is running, access the dashboard from your host browser:

```bash
# The dashboard should be available at:
open http://localhost:57374
```

If using the API:

```bash
curl http://localhost:57374/api/health
```

## Step 5: Configure Resource Limits

Test resource configuration by modifying environment variables:

```bash
# Run with budget limit and reduced parallel agents
docker-compose run \
  -e ANTHROPIC_API_KEY \
  -e LOKI_BUDGET_LIMIT=5.00 \
  -e LOKI_MAX_PARALLEL_AGENTS=3 \
  -e LOKI_MAX_ITERATIONS=50 \
  loki start --simple ./prd.md
```

## Step 6: Use the Sandbox Mode

Test the sandbox mode which provides additional isolation:

```bash
# Build the sandbox image
loki sandbox build

# Start the sandbox
loki sandbox start

# Check status
loki sandbox status

# Open a shell inside the sandbox
loki sandbox shell

# View logs
loki sandbox logs

# Stop the sandbox
loki sandbox stop
```

## Step 7: Verify Health Monitoring

Check process and system health:

```bash
# From inside the container or on the host with loki installed:
loki watchdog status
loki secrets status
```

## Verification Checklist

- [ ] `docker-compose build` completes without errors
- [ ] `docker-compose run loki version` outputs the correct version
- [ ] The dashboard is accessible at `http://localhost:57374`
- [ ] You can pass environment variables to configure resource limits
- [ ] `loki sandbox` commands work (build, start, status, stop)
- [ ] You understand the volume mounts and their permissions (rw vs ro)

## Cleanup

```bash
# Stop any running containers
docker-compose down

# Remove test directory
cd ~
rm -rf /tmp/docker-lab

# Optional: remove the Docker image
docker rmi loki-mode:latest
```
