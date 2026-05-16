# Sandbox Mode

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

### Full Configuration (v7.6.0+)

```yaml
# .loki/config.yaml
sandbox:
  # Image and runtime resources
  image: "loki-mode:sandbox"
  network: "bridge"       # bridge | none | host
  cpus: "2"
  memory: "4g"
  readonly: false

  # Egress rules (comma-separated; wildcards and CIDR supported)
  # Consumed by the vault sidecar (Phase B) and the diagnose command.
  egress:
    allow: "*.anthropic.com,*.github.com,10.0.0.0/8"
    deny:  "169.254.169.254/32"

  # Optional credential vault sidecar (Phase B; opt-in)
  vault:
    enabled: false
```

All keys also accept `security.*` legacy forms (`security.sandbox_mode`, `security.allowed_paths`, `security.blocked_commands`) which continue to work unchanged.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_SANDBOX_MODE` | `false` | Enable sandbox |
| `LOKI_SANDBOX_IMAGE` | `loki-mode:sandbox` | Docker image |
| `LOKI_SANDBOX_NETWORK` | `bridge` | `bridge` / `none` / `host` |
| `LOKI_SANDBOX_CPUS` | `2` | CPU limit (passed to `--cpus`) |
| `LOKI_SANDBOX_MEMORY` | `4g` | Memory limit |
| `LOKI_SANDBOX_READONLY` | `false` | Mount project read-only |
| `LOKI_SANDBOX_EGRESS_ALLOW` | _empty_ | Comma-separated allow rules (v7.6.0) |
| `LOKI_SANDBOX_EGRESS_DENY` | _empty_ | Comma-separated deny rules (v7.6.0) |
| `LOKI_SANDBOX_VAULT_ENABLED` | `false` | Opt into vault sidecar (v7.6.0; sidecar lands in 7.7) |

### Diagnose (v7.6.0+)

```bash
loki sandbox diagnose            # human-readable summary
loki sandbox diagnose --json     # machine-readable, schema loki.sandbox.diagnose/v1
```

Typed detection codes:

| Code | Severity | Meaning |
|------|----------|---------|
| `DKR001` | critical | docker CLI missing or daemon unreachable |
| `SBX002` | warn | nested sandbox detected (refused at runtime) |
| `CRD003` | warn | no provider API key in caller env |
| `EGR004` | critical | `LOKI_SANDBOX_NETWORK=host` exposes the host network namespace |
| `LND005` | warn/info | Landlock kernel support unavailable (path enforcement degrades to warn-only) |
| `VLT006` | critical | vault sidecar enabled but `127.0.0.1:14322/healthz` did not respond |
| `AUD007` | critical | dashboard audit chain verification failed |
| `RES008` | info | resource limits at stock defaults |

### Per-session environment variables (v7.6.0+)

```bash
loki sandbox start --env-var GITHUB_TOKEN=ghp_xxx --env-var GH_REPO=org/repo
```

- Repeatable; max 50 entries, total payload ≤ 16 KB.
- Keys must match `^[A-Za-z_][A-Za-z0-9_]*$`.
- Values must contain only printable ASCII (no newlines, no control bytes).
- Reserved keys are rejected: `LOKI_*`, `LD_*`, `DOCKER_*`, `PATH`, `HOME`, `USER`, `SHELL`, `PWD`, `OLDPWD`, `IFS`, `TERM`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `REPO_URL`, `BRANCH`, `AGENT_PROMPT`, `GIT_TOKEN`.

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
