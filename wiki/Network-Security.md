# Network Security

This document covers network egress control strategies for Loki Mode deployments. These configurations restrict outbound network access from containers and pods to only the AI API endpoints required for operation.

## Docker Network Isolation

### Custom Network with ICC Disabled

Create an isolated Docker network that prevents inter-container communication and restricts egress to known AI API endpoints.

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
# Google (Gemini)
iptables -A DOCKER-USER -d generativelanguage.googleapis.com -p tcp --dport 443 -j ACCEPT

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

**Note:** Docker DNS-based iptables rules resolve at rule creation time. If provider IPs change, rules must be refreshed. For production use, consider a forward proxy (e.g., Squid, Envoy) with domain-based allowlisting instead of raw iptables.

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
    # NOTE: NetworkPolicy does not support FQDN-based rules natively.
    # Use a CNI plugin that supports FQDN egress rules (Cilium, Calico Enterprise)
    # or route through an egress gateway / proxy.
    - to: []
      ports:
        - protocol: TCP
          port: 443
```

**Important:** Standard Kubernetes `NetworkPolicy` only supports IP-based rules, not domain names. To enforce domain-level egress control, use one of these approaches:

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

## Environment Variables

The following environment variables are documented for future network egress policy enforcement.

> **Planned -- not yet enforced.** These variables are reserved for a future release. Setting them today has no effect on runtime behavior. They are listed here to establish the interface contract.

| Variable | Description | Default | Status |
|---|---|---|---|
| `LOKI_NETWORK_EGRESS_POLICY` | Controls egress behavior: `unrestricted` (default), `ai-only` (restrict to AI APIs), `none` (block all outbound) | `unrestricted` | Planned -- not yet enforced |
| `LOKI_ALLOWED_HOSTS` | Comma-separated list of additional hostnames to allow when egress policy is `ai-only` | (empty) | Planned -- not yet enforced |
| `LOKI_BLOCK_METADATA_ENDPOINT` | Block cloud metadata endpoint (169.254.169.254) from within the application | `false` | Planned -- not yet enforced |

When these variables are implemented, they will be enforced at the application level as a defense-in-depth measure alongside the network-level controls described above.
