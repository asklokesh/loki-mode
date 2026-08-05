# Network Security

Network egress control and isolation for Loki Mode deployments.

## Overview

This guide covers network-level security controls for restricting outbound network access from Loki Mode containers and pods to only the AI API endpoints required for operation.

## Environment Variables

**None of the variables below are implemented. Do not rely on them.** They are
reserved names for a planned application-level enforcement layer, and no
runtime code reads any of them today. Network security is enforced entirely at
the infrastructure level, using the Docker network and Kubernetes NetworkPolicy
recipes in the rest of this guide.

| Variable | Default | Description | Status |
|----------|---------|-------------|--------|
| `LOKI_NETWORK_EGRESS_POLICY` | `unrestricted` | `unrestricted` (default), `ai-only` (restrict to AI APIs), `none` (block all outbound) | Planned, target TBD |
| `LOKI_ALLOWED_HOSTS` | (empty) | Comma-separated list of additional hostnames to allow when egress policy is `ai-only` | Planned, target TBD |
| `LOKI_BLOCK_METADATA_ENDPOINT` | `false` | Block cloud metadata endpoint (169.254.169.254) from within the application | Planned, target TBD |

## Docker Network Isolation

### Custom Network with ICC Disabled

Create an isolated Docker network that prevents inter-container communication and restricts egress to known AI API endpoints:

```bash
# Create an isolated bridge network with ICC disabled
docker network create \
  --driver bridge \
  --opt com.docker.network.bridge.enable_icc=false \
  --subnet 172.28.0.0/16 \
  loki-isolated
```

### Blocking the Cloud Metadata Endpoint

Cloud providers expose instance metadata at `169.254.169.254`. This endpoint can leak credentials (IAM roles, service account tokens). Block it from within the container host:

```bash
# Block metadata endpoint for containers on the loki-isolated network
iptables -I DOCKER-USER -d 169.254.169.254 -j DROP
```

### Allowing Only AI API Endpoints

Restrict outbound traffic to only the AI provider API endpoints that Loki Mode requires:

```bash
# Allow DNS resolution
iptables -A DOCKER-USER -p udp --dport 53 -j ACCEPT
iptables -A DOCKER-USER -p tcp --dport 53 -j ACCEPT

# Allow HTTPS to AI API endpoints only
# Anthropic (Claude)
iptables -A DOCKER-USER -d api.anthropic.com -p tcp --dport 443 -j ACCEPT
# OpenAI (Codex)
iptables -A DOCKER-USER -d api.openai.com -p tcp --dport 443 -j ACCEPT
# Add one rule per endpoint your chosen provider actually calls. Cline, Aider,
# and opencode are model-agnostic, so their endpoints depend on your config.
# The Gemini rule that used to sit here was removed with the provider (v7.5.18);
# do not re-add an allowlist entry for a provider you are not running.

# Drop all other outbound traffic from the isolated network
iptables -A DOCKER-USER -s 172.28.0.0/16 -j DROP
```

### Docker Compose Example

```yaml
version: "3.8"

services:
  loki:
    image: asklokesh/loki-mode:latest
    networks:
      - loki-isolated
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp
    volumes:
      - ./workspace:/workspace

networks:
  loki-isolated:
    driver: bridge
    driver_opts:
      com.docker.network.bridge.enable_icc: "false"
```

Note: Docker DNS-based iptables rules resolve at rule creation time. If provider IPs change, rules must be refreshed. For production use, consider a forward proxy (e.g., Squid, Envoy) with domain-based allowlisting instead of raw iptables.

## Kubernetes NetworkPolicy

### Egress-Restricted NetworkPolicy

The following `NetworkPolicy` restricts pod egress to only the AI API endpoints and DNS:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: loki-egress-policy
  namespace: loki
spec:
  podSelector:
    matchLabels:
      app: loki-mode
  policyTypes:
    - Egress
  egress:
    # Allow DNS resolution
    - to: []
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    # Allow HTTPS to AI API endpoints
    - to: []
      ports:
        - protocol: TCP
          port: 443
```

Important: Standard Kubernetes `NetworkPolicy` only supports IP-based rules, not domain names. To enforce domain-level egress control, use one of these approaches:

- **Cilium**: Supports `CiliumNetworkPolicy` with FQDN-based egress rules
- **Calico Enterprise**: Supports DNS-based network policies
- **Egress Gateway**: Route traffic through a proxy that enforces domain allowlists

### Pod Security Context

Run Loki Mode pods with a restrictive security context:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: loki-worker
  namespace: loki
  labels:
    app: loki-mode
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: loki
      image: asklokesh/loki-mode:latest
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
      volumeMounts:
        - name: workspace
          mountPath: /workspace
        - name: tmp
          mountPath: /tmp
      env:
        - name: ANTHROPIC_API_KEY
          valueFrom:
            secretKeyRef:
              name: loki-secrets
              key: anthropic-api-key
  volumes:
    - name: workspace
      emptyDir: {}
    - name: tmp
      emptyDir:
        medium: Memory
        sizeLimit: 256Mi
```

## TLS/HTTPS for Dashboard (v5.36.0)

Enable encrypted dashboard connections:

```bash
# HTTPS turns on when BOTH are set. There is no LOKI_TLS_ENABLED switch.
export LOKI_TLS_CERT=/path/to/cert.pem
export LOKI_TLS_KEY=/path/to/key.pem

loki start ./prd.md
```

Or via CLI flags:

```bash
loki dashboard start --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

### Self-Signed Certificate (Development)

```bash
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/CN=localhost"

export LOKI_TLS_CERT=cert.pem
export LOKI_TLS_KEY=key.pem
```

### Production TLS

For production deployments, use certificates from a trusted CA:

- Let's Encrypt (free, automated)
- AWS Certificate Manager
- Your organization's internal CA

## Best Practices

### Security Checklist

- Enable TLS/HTTPS for dashboard in production
- Use network policies to restrict egress to AI API endpoints only
- Block cloud metadata endpoint (169.254.169.254)
- Run containers with read-only root filesystem
- Use non-root user (UID 1000)
- Drop all capabilities
- Enable seccomp profile
- Use separate networks for different security zones
- Monitor network traffic for anomalies

### Production Deployment

1. Enable TLS with valid certificates
2. Configure network policies or iptables rules
3. Use a reverse proxy (nginx, Envoy) for additional security headers
4. Enable audit logging to track network-related events
5. Monitor `/metrics` endpoint for unexpected traffic patterns

## Troubleshooting

### Connection to AI API Fails

```bash
# Check network policy
kubectl describe networkpolicy loki-egress-policy

# Test DNS resolution
kubectl exec -it loki-pod -- nslookup api.anthropic.com

# Check iptables rules
sudo iptables -L DOCKER-USER -n -v
```

### Dashboard HTTPS Not Working

```bash
# Verify certificate files exist and are readable
ls -la /path/to/cert.pem /path/to/key.pem

# Check certificate validity
openssl x509 -in cert.pem -text -noout

# Verify dashboard is listening on HTTPS
curl -k https://localhost:57374/health
```

## See Also

- [Authentication Guide](authentication.md) - OIDC/SSO setup
- [Authorization Guide](authorization.md) - RBAC configuration
- [Audit Logging](audit-logging.md) - Security event tracking
- [Enterprise Features](../wiki/Enterprise-Features.md) - Complete enterprise guide
