# Sandbox Mode

> Legacy engine note: this page documents the legacy engine (`loki start`, `LOKI_ENGINE=legacy`), which still ships in 10.6.6 and is being removed. For the current Loki 10 commands (`loki "<task>"`, `loki owner/repo#N`, `loki backlog`, `loki verify`) see [[Home]] and [docs/v10/GUIDE.md](https://github.com/asklokesh/loki-mode/blob/main/docs/v10/GUIDE.md).

Docker-based isolation for secure execution.

---

## Overview

Sandbox mode runs Loki Mode in an isolated Docker container, providing:

- Filesystem isolation
- Network restrictions
- Resource limits
- No access to host system

Use sandbox mode for:
- Untrusted code
- CI/CD pipelines
- Shared development environments
- Compliance requirements

---

## Enabling Sandbox Mode

### Environment Variable

```bash
export LOKI_SANDBOX_MODE=true
loki start ./prd.md
```

### CLI Flag

```bash
loki start ./prd.md --sandbox
```

### Configuration File

```yaml
# .loki/config.yaml
sandbox:
  enabled: true
```

---

## Sandbox Commands

### Start Sandbox

```bash
loki sandbox start
```

### Stop Sandbox

```bash
loki sandbox stop
```

### Check Status

```bash
loki sandbox status
```

### View Logs

```bash
loki sandbox logs
loki sandbox logs --follow
```

### Open Shell

```bash
loki sandbox shell
```

### Build Image

Build custom sandbox image:

```bash
loki sandbox build
```

---

## Configuration Options

### Full Configuration

```yaml
# .loki/config.yaml
sandbox:
  enabled: true
  image: "asklokesh/loki-mode:latest"

  # Resource limits
  memory_limit: "4g"
  cpu_limit: "2"

  # Network
  network: false  # Disable network access

  # Filesystem mounts
  mounts:
    - "./:/workspace:rw"           # Project directory
    - "~/.npm:/root/.npm:ro"       # npm cache (read-only)
    - "~/.claude:/home/loki/.claude:ro" # Claude auth (read-only)

  # Environment variables to pass
  env:
    - ANTHROPIC_API_KEY
    - LOKI_PROVIDER
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_SANDBOX_MODE` | `false` | Enable sandbox |
| `LOKI_SANDBOX_IMAGE` | `loki-mode:sandbox` | Docker image |
| `LOKI_SANDBOX_MEMORY` | `4g` | Memory limit |
| `LOKI_SANDBOX_CPUS` | `2` | CPU limit |
| `LOKI_SANDBOX_NETWORK` | `bridge` | Network mode: `bridge`, `none`, `host` |

---

## Docker Image

### Official Image

```bash
docker pull asklokesh/loki-mode:latest
```

### Building Custom Image

Create `Dockerfile.sandbox`:

```dockerfile
FROM asklokesh/loki-mode:latest

# Add custom tools
RUN npm install -g your-tool

# Custom configuration
COPY .loki/config.yaml /root/.config/loki-mode/config.yaml
```

Build:

```bash
docker build -f Dockerfile.sandbox -t my-loki-sandbox .
loki sandbox build --image my-loki-sandbox
```

---

## Network Configuration

### Disable Network

For maximum isolation:

```yaml
sandbox:
  network: false
```

### Allow Specific Hosts

Allow only AI provider APIs:

```yaml
sandbox:
  network: true
  allowed_hosts:
    - api.anthropic.com
    - api.openai.com
```

---

## Volume Mounts

### Default Mounts

| Host Path | Container Path | Mode | Purpose |
|-----------|----------------|------|---------|
| `.` | `/workspace` | rw | Project files |
| `~/.claude` | `/home/loki/.claude` | ro | Claude auth |

### Adding Custom Mounts

```yaml
sandbox:
  mounts:
    - "./:/workspace:rw"
    - "/path/to/data:/data:ro"
    - "~/.aws:/home/loki/.aws:ro"
```

---

## Resource Limits

### Memory

```yaml
sandbox:
  memory_limit: "8g"
  memory_swap: "16g"
```

### CPU

```yaml
sandbox:
  cpu_limit: "4"
  cpu_shares: 1024
```

### Storage

```yaml
sandbox:
  storage_limit: "50g"
```

---

## Security Considerations

### What Sandbox Prevents

| Threat | Mitigation | Details |
|--------|------------|---------|
| Host filesystem access | Explicit mounts only | |
| Network exfiltration | Optional network disable | |
| Resource exhaustion | CPU/memory limits | |
| Privilege escalation | Non-root + no SETUID/SETGID | Runs as UID 1000, Docker capabilities dropped (v5.37.1) |

### What Sandbox Does NOT Prevent

| Limitation | Mitigation |
|------------|------------|
| AI provider data exposure | Use provider's data policies |
| Mounted volume access | Limit mounts, use read-only |
| Network to allowed hosts | Disable network if needed |

### Security Hardening (v5.36.0+)

The sandbox container applies these security measures:
- **Non-root execution**: Runs as UID 1000 (appuser)
- **No SETUID/SETGID**: Docker capabilities intentionally dropped (v5.37.1)
- **Rate limiting**: API endpoints limited to 10 req/min for session control
- **Salted token hashing**: SHA-256 with per-token random salt
- **Input validation**: Shell injection prevention on all user inputs

---

## Troubleshooting

### Docker Not Found

```bash
# Install Docker
brew install docker  # macOS
apt install docker.io  # Ubuntu

# Start Docker daemon
docker info
```

### Permission Denied

```bash
# Add user to docker group
sudo usermod -aG docker $USER

# Or run with sudo
sudo loki sandbox start
```

### Container Won't Start

```bash
# Check Docker status
docker info

# Check for port conflicts
lsof -i :57374

# View container logs
docker logs loki-sandbox
```

### Out of Memory

```bash
# Increase memory limit
export LOKI_SANDBOX_MEMORY=8g

# Or in config
sandbox:
  memory_limit: "8g"
```

---

## CI/CD Integration

### GitHub Actions

```yaml
jobs:
  loki:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run Loki Mode in sandbox
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          LOKI_SANDBOX_MODE: true
        run: |
          npm install -g loki-mode
          loki start ./prd.md --sandbox
```

### GitLab CI

```yaml
loki-build:
  image: docker:latest
  services:
    - docker:dind
  script:
    - npm install -g loki-mode
    - export LOKI_SANDBOX_MODE=true
    - loki start ./prd.md --sandbox
```

---

## See Also

- [[Security]] - Security best practices
- [[Enterprise Features]] - Enterprise security
- [[Configuration]] - Configuration options
